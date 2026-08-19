"""
detect.py

Fire/smoke detection inference using a trained YOLO model. Supports images,
folders of images, video files, webcams, RTSP streams, and ESP32-CAM streams.

Alerts (fire/smoke detections above the confidence threshold) are:
  - printed to the console with a timestamp
  - appended to a CSV log file (runs/detect_output/alerts.csv by default)
  - saved as annotated snapshot images (runs/detect_output/alerts/) with a
    per-class cooldown so continuous detections don't flood your disk

Usage:
    # Single image or folder of images
    python detect.py --weights best.pt --source path/to/image_or_folder

    # Video file
    python detect.py --weights best.pt --source path/to/video.mp4

    # Webcam (device index 0)
    python detect.py --weights best.pt --source 0

    # RTSP / generic IP camera stream
    python detect.py --weights best.pt --source "rtsp://user:pass@camera-ip/stream"

    # ESP32-CAM (AI-Thinker CameraWebServer firmware, default MJPEG port 81)
    python detect.py --weights best.pt --esp32cam-ip 192.168.1.50

    # ESP32-CAM with a non-default stream path/port
    python detect.py --weights best.pt --source "http://192.168.1.50:81/stream"
"""

import argparse
import csv
import time
from datetime import datetime
from pathlib import Path

import cv2
from ultralytics import YOLO

# BGR colors (OpenCV convention) per class, used for box/label drawing
CLASS_COLORS = {
    "fire": (255, 255, 0),  # cyan
    "smoke": (255, 0, 0),  # blue
}
DEFAULT_COLOR = (0, 255, 0)


class AlertLogger:
    """Handles console printing, CSV logging, and cooldown-gated snapshot saving."""

    def __init__(self, save_dir: Path, cooldown_seconds: float = 5.0):
        self.save_dir = save_dir
        self.alerts_dir = save_dir / "alerts"
        self.alerts_dir.mkdir(parents=True, exist_ok=True)
        self.csv_path = save_dir / "alerts.csv"
        self.cooldown_seconds = cooldown_seconds
        self._last_alert_time = {"fire": 0.0, "smoke": 0.0}

        if not self.csv_path.exists():
            with open(self.csv_path, "w", newline="") as f:
                csv.writer(f).writerow(["timestamp", "class", "count", "max_confidence", "snapshot"])

    def maybe_log(self, class_name: str, count: int, max_conf: float, frame) -> bool:
        """Log + save snapshot if this class isn't in cooldown. Returns True if logged."""
        now = time.time()
        if now - self._last_alert_time[class_name] < self.cooldown_seconds:
            return False
        self._last_alert_time[class_name] = now

        timestamp = datetime.now()
        ts_str = timestamp.strftime("%Y-%m-%d %H:%M:%S")
        ts_file = timestamp.strftime("%Y%m%d_%H%M%S_%f")[:-3]
        snapshot_name = f"{class_name}_{ts_file}.jpg"
        snapshot_path = self.alerts_dir / snapshot_name

        if frame is not None:
            cv2.imwrite(str(snapshot_path), frame)

        with open(self.csv_path, "a", newline="") as f:
            csv.writer(f).writerow([ts_str, class_name, count, f"{max_conf:.3f}", snapshot_name])

        print(f"[ALERT {ts_str}] {class_name.upper()} detected x{count} (max conf {max_conf:.2f}) -> {snapshot_name}")
        return True


def draw_detections(frame, boxes, class_names):
    """Draw styled bounding boxes + labels on a frame. Returns per-class (count, max_conf)."""
    stats = {}
    if boxes is None or len(boxes) == 0:
        return stats

    for xyxy, cls_id, conf in zip(boxes.xyxy.tolist(), boxes.cls.tolist(), boxes.conf.tolist()):
        label = class_names[int(cls_id)]
        color = CLASS_COLORS.get(label, DEFAULT_COLOR)
        x1, y1, x2, y2 = map(int, xyxy)

        cv2.rectangle(frame, (x1, y1), (x2, y2), color, 2)
        text = f"{label.upper()} {conf:.2f}"
        (tw, th), _ = cv2.getTextSize(text, cv2.FONT_HERSHEY_SIMPLEX, 0.55, 2)
        cv2.rectangle(frame, (x1, y1 - th - 8), (x1 + tw + 6, y1), color, -1)
        cv2.putText(frame, text, (x1 + 3, y1 - 5), cv2.FONT_HERSHEY_SIMPLEX, 0.55, (255, 255, 255), 2)

        prev_count, prev_max = stats.get(label, (0, 0.0))
        stats[label] = (prev_count + 1, max(prev_max, conf))

    return stats


def draw_hud(frame, fps: float, source_label: str):
    """Small heads-up overlay: FPS + source name, top-left corner."""
    h, w = frame.shape[:2]
    overlay_text = f"{source_label} | {fps:.1f} FPS"
    cv2.rectangle(frame, (0, 0), (min(w, 15 * len(overlay_text) + 10), 28), (0, 0, 0), -1)
    cv2.putText(frame, overlay_text, (6, 19), cv2.FONT_HERSHEY_SIMPLEX, 0.55, (0, 255, 0), 1)


def resolve_source(args) -> tuple:
    """Returns (source, is_stream, display_label)."""
    if args.esp32cam_ip:
        url = f"http://{args.esp32cam_ip}:{args.esp32cam_port}{args.esp32cam_path}"
        return url, True, f"ESP32-CAM {args.esp32cam_ip}"

    src = args.source
    if src is None:
        raise SystemExit("Provide --source or --esp32cam-ip")

    if src.isdigit():
        return int(src), True, f"Webcam {src}"
    if src.startswith("rtsp://") or src.startswith("http://") or src.startswith("https://"):
        return src, True, "IP Camera"

    # File / folder source
    path = Path(src)
    is_video_file = path.suffix.lower() in {".mp4", ".avi", ".mov", ".mkv"}
    return src, is_video_file, str(path.name)


def run_stream(model, class_names, source, source_label, args, logger: AlertLogger):
    """Live loop for webcam / RTSP / ESP32-CAM / video file sources using OpenCV capture."""
    cap = cv2.VideoCapture(source)
    if not cap.isOpened():
        raise SystemExit(f"Could not open video source: {source}")

    print(f"Connected to source: {source_label} ({source})") 
    print("Press 'q' in the preview window to quit, or 'f' to toggle fullscreen." if not args.no_show else "Running headless (--no-show).")

    window_name = "Fire/Smoke Detection"
    if not args.no_show:
        cv2.namedWindow(window_name, cv2.WINDOW_NORMAL)
        cv2.resizeWindow(window_name, 800, 600)
        cv2.moveWindow(window_name, 50, 50)
    fps_smoothed = 0.0
    prev_time = time.time()

    while True:
        ok, frame = cap.read()
        if not ok:
            print("Stream ended or frame read failed.")
            break

        results = model.predict(
            source=frame,
            conf=args.conf,
            iou=args.iou,
            device=args.device,
            verbose=False,
        )
        boxes = results[0].boxes
        stats = draw_detections(frame, boxes, class_names)

        for label, (count, max_conf) in stats.items():
            if label in ("fire", "smoke"):
                logger.maybe_log(label, count, max_conf, frame)

        now = time.time()
        inst_fps = 1.0 / max(now - prev_time, 1e-6)
        fps_smoothed = inst_fps if fps_smoothed == 0 else (0.9 * fps_smoothed + 0.1 * inst_fps)
        prev_time = now

        if not args.no_show:
            draw_hud(frame, fps_smoothed, source_label)
            cv2.imshow("Fire/Smoke Detection", frame)
            if cv2.waitKey(1) & 0xFF == ord("q"):
                break

    cap.release()
    if not args.no_show:
        cv2.destroyAllWindows()


def run_static(model, args, logger: AlertLogger, class_names):
    """Batch inference over an image or folder of images."""
    results = model.predict(
        source=args.source,
        conf=args.conf,
        iou=args.iou,
        device=args.device,
        stream=True,
        save=True,
        project=str(logger.save_dir.parent),
        name=logger.save_dir.name,
        exist_ok=True,
        verbose=False,
    )

    for result in results:
        frame = result.orig_img.copy()
        stats = draw_detections(frame, result.boxes, class_names)
        for label, (count, max_conf) in stats.items():
            if label in ("fire", "smoke"):
                logger.maybe_log(label, count, max_conf, frame)

    print(f"\nAnnotated output saved under: {logger.save_dir}")
    print(f"Alert log: {logger.csv_path}")


def main():
    parser = argparse.ArgumentParser(description="Fire/smoke detection inference")
    parser.add_argument("--weights", required=True, help="Path to trained .pt weights")
    parser.add_argument("--source", default=None, help="Image path, folder, video path, webcam index, or stream URL")
    parser.add_argument("--esp32cam-ip", default=None, help="ESP32-CAM IP address, e.g. 192.168.1.50 (shortcut for --source)")
    parser.add_argument("--esp32cam-port", default=81, type=int, help="ESP32-CAM MJPEG stream port (AI-Thinker default: 81)")
    parser.add_argument("--esp32cam-path", default="/stream", help="ESP32-CAM MJPEG stream path")
    parser.add_argument("--conf", type=float, default=0.6, help="Confidence threshold")
    parser.add_argument("--iou", type=float, default=0.5, help="NMS IoU threshold")
    parser.add_argument("--device", default="0", help="'0' for GPU, 'cpu' for CPU")
    parser.add_argument("--save-dir", default="runs/detect_output", help="Where to save annotated output / logs")
    parser.add_argument("--cooldown", type=float, default=5.0, help="Seconds between repeated alerts per class")
    parser.add_argument("--no-show", action="store_true", help="Don't pop up a live preview window")
    args = parser.parse_args()

    model = YOLO(args.weights)
    class_names = model.names  # e.g. {0: 'smoke', 1: 'fire'}

    save_dir = Path(args.save_dir)
    save_dir.mkdir(parents=True, exist_ok=True)
    logger = AlertLogger(save_dir, cooldown_seconds=args.cooldown)

    source, is_stream, source_label = resolve_source(args)

    if is_stream:
        run_stream(model, class_names, source, source_label, args, logger)
    else:
        run_static(model, args, logger, class_names)


if __name__ == "__main__":
    main()
