"""HTTP API for the Fire & Smoke Detection dashboard.

Run with: uvicorn app:app --host 0.0.0.0 --port 8000
"""

import base64
import csv
from datetime import datetime
from pathlib import Path
from threading import Lock

import cv2
import numpy as np
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from ultralytics import YOLO

ROOT = Path(__file__).parent
WEIGHTS = ROOT / "best.pt"
ALERTS_CSV = ROOT / "runs" / "detect_output" / "alerts.csv"
ALERTS_DIR = ALERTS_CSV.parent / "alerts"
MODEL_LOCK = Lock()
ALERT_LOCK = Lock()
model = None
LAST_ALERT = {"fire": 0.0, "smoke": 0.0}

app = FastAPI(title="Fire & Smoke Detector API")
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"https?://[^/:]+:\d+|https?://(localhost|127\.0\.0\.1|\[::1\]):\d+",
    allow_methods=["*"],
    allow_headers=["*"],
    allow_credentials=True,
)


def get_model():
    global model
    if model is None:
        if not WEIGHTS.exists():
            raise HTTPException(500, "Model weights (best.pt) were not found.")
        model = YOLO(str(WEIGHTS))
    return model


def save_alerts(detections, frame, cooldown=5):
    """Persist fire/smoke events from the dashboard's live sources."""
    now = datetime.now()
    timestamp = now.strftime("%Y-%m-%d %H:%M:%S")
    stem = now.strftime("%Y%m%d_%H%M%S_%f")[:-3]
    alert_dir = ALERTS_DIR
    alert_dir.mkdir(parents=True, exist_ok=True)
    grouped = {}
    for item in detections:
        label = item["label"].lower()
        if label in LAST_ALERT:
            count, maximum = grouped.get(label, (0, 0.0))
            grouped[label] = (count + 1, max(maximum, item["confidence"]))
    with ALERT_LOCK:
        for label, (count, maximum) in grouped.items():
            if now.timestamp() - LAST_ALERT[label] < cooldown:
                continue
            LAST_ALERT[label] = now.timestamp()
            filename = f"{label}_{stem}.jpg"
            cv2.imwrite(str(alert_dir / filename), frame)
            new_file = not ALERTS_CSV.exists()
            with ALERTS_CSV.open("a", newline="", encoding="utf-8") as file:
                writer = csv.writer(file)
                if new_file:
                    writer.writerow(["timestamp", "class", "count", "max_confidence", "snapshot"])
                writer.writerow([timestamp, label, count, f"{maximum:.3f}", filename])


def infer(frame, confidence):
    with MODEL_LOCK:
        result = get_model().predict(frame, conf=confidence, verbose=False)[0]
    detections = []
    for box in result.boxes:
        detections.append({
            "label": result.names[int(box.cls[0])],
            "confidence": round(float(box.conf[0]), 3),
            "box": [round(float(v), 1) for v in box.xyxy[0].tolist()],
        })
    annotated = frame.copy()
    colors = {
        "fire": (255, 255, 0),  # cyan in BGR
        "smoke": (255, 0, 0),  # blue in BGR
    }
    for detection in detections:
        x1, y1, x2, y2 = map(int, detection["box"])
        color = colors.get(detection["label"].lower(), (0, 255, 0))
        label = f"{detection['label'].upper()} {detection['confidence']:.2f}"
        cv2.rectangle(annotated, (x1, y1), (x2, y2), color, 3)
        (text_width, text_height), _ = cv2.getTextSize(
            label, cv2.FONT_HERSHEY_SIMPLEX, 0.65, 2
        )
        label_top = max(0, y1 - text_height - 10)
        cv2.rectangle(
            annotated,
            (x1, label_top),
            (x1 + text_width + 10, y1),
            color,
            -1,
        )
        cv2.putText(
            annotated,
            label,
            (x1 + 5, max(text_height + 2, y1 - 6)),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.65,
            (0, 0, 0),
            2,
            cv2.LINE_AA,
        )
    return detections, annotated


@app.get("/api/health")
def health():
    return {"status": "ready", "model": WEIGHTS.name, "loaded": model is not None}


@app.get("/api/alerts")
def alerts():
    if not ALERTS_CSV.exists():
        return []
    with ALERTS_CSV.open(newline="", encoding="utf-8") as file:
        rows = list(csv.DictReader(file))
    return list(reversed(rows[-30:]))


@app.get("/api/alerts/{snapshot_name}")
def alert_snapshot(snapshot_name: str):
    """Serve a saved alert image without allowing access outside the alert folder."""
    snapshot_path = ALERTS_DIR / Path(snapshot_name).name
    if snapshot_path.name != snapshot_name or not snapshot_path.is_file():
        raise HTTPException(404, "Alert snapshot was not found.")
    return FileResponse(snapshot_path, media_type="image/jpeg")


@app.post("/api/detect")
async def detect(image: UploadFile = File(...), confidence: float = 0.6):
    if not 0.05 <= confidence <= 0.95:
        raise HTTPException(422, "Confidence must be between 0.05 and 0.95.")
    if image.content_type and not image.content_type.startswith("image/"):
        raise HTTPException(415, "Please upload an image file.")

    raw = await image.read()
    frame = cv2.imdecode(np.frombuffer(raw, np.uint8), cv2.IMREAD_COLOR)
    if frame is None:
        raise HTTPException(422, "The uploaded file could not be read as an image.")

    detections, annotated = infer(frame, confidence)
    save_alerts(detections, annotated)
    ok, encoded = cv2.imencode(".jpg", annotated)
    if not ok:
        raise HTTPException(500, "Could not encode the result image.")
    preview = "data:image/jpeg;base64," + base64.b64encode(encoded.tobytes()).decode()
    return {
        "processed_at": datetime.now().isoformat(timespec="seconds"),
        "detections": detections,
        "preview": preview,
    }


@app.get("/api/stream")
def stream(source: str, confidence: float = 0.6):
    """Annotated MJPEG for a webcam index, RTSP feed, or ESP32-CAM stream URL."""
    if not 0.05 <= confidence <= 0.95:
        raise HTTPException(422, "Confidence must be between 0.05 and 0.95.")
    capture_source = int(source) if source.isdigit() else source
    if not isinstance(capture_source, int) and not source.startswith(("http://", "https://", "rtsp://")):
        raise HTTPException(422, "Use a webcam number, HTTP(S), or RTSP camera URL.")

    def frames():
        capture = cv2.VideoCapture(capture_source)
        if not capture.isOpened():
            return
        fps_smoothed = 0.0
        previous_time = datetime.now().timestamp()
        try:
            while True:
                ok, frame = capture.read()
                if not ok:
                    break
                detections, annotated = infer(frame, confidence)
                save_alerts(detections, annotated)
                current_time = datetime.now().timestamp()
                instant_fps = 1.0 / max(current_time - previous_time, 1e-6)
                fps_smoothed = instant_fps if fps_smoothed == 0 else (0.9 * fps_smoothed + 0.1 * instant_fps)
                previous_time = current_time
                cv2.rectangle(annotated, (0, 0), (150, 32), (7, 13, 13), -1)
                cv2.putText(
                    annotated,
                    f"LIVE  {fps_smoothed:.1f} FPS",
                    (10, 22),
                    cv2.FONT_HERSHEY_SIMPLEX,
                    0.58,
                    (0, 230, 170),
                    2,
                )
                ok, encoded = cv2.imencode(".jpg", annotated, [cv2.IMWRITE_JPEG_QUALITY, 82])
                if ok:
                    yield b"--frame\r\nContent-Type: image/jpeg\r\n\r\n" + encoded.tobytes() + b"\r\n"
        finally:
            capture.release()

    return StreamingResponse(frames(), media_type="multipart/x-mixed-replace; boundary=frame")
