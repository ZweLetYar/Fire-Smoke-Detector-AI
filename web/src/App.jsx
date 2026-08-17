import { useEffect, useRef, useState } from "react";

const API = import.meta.env.VITE_API_URL || "http://localhost:8000";

export default function App() {
  const [confidence, setConfidence] = useState(0.6);
  const [file, setFile] = useState(null);
  const [result, setResult] = useState(null);
  const [alerts, setAlerts] = useState([]);
  const [status, setStatus] = useState(
    "Drop an image or use your camera to begin.",
  );
  const [loading, setLoading] = useState(false);
  const [cameraOn, setCameraOn] = useState(false);
  const [sourceType, setSourceType] = useState("browser");
  const [deviceId, setDeviceId] = useState("");
  const [devices, setDevices] = useState([]);
  const [networkSource, setNetworkSource] = useState("");
  const [streamUrl, setStreamUrl] = useState("");
  const [monitoring, setMonitoring] = useState(false);
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const monitorRef = useRef(false);
  const busyRef = useRef(false);

  const loadAlerts = async () => {
    try {
      setAlerts(await (await fetch(`${API}/api/alerts`)).json());
    } catch {
      /* API may not yet be running */
    }
  };
  useEffect(() => {
    loadAlerts();
    listCameras();
    return stopCamera;
  }, []);
  useEffect(() => {
    if (cameraOn && videoRef.current && streamRef.current) {
      videoRef.current.srcObject = streamRef.current;
    }
  }, [cameraOn]);

  function stopCamera() {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    setCameraOn(false);
    monitorRef.current = false;
    setMonitoring(false);
    setStreamUrl("");
  }
  async function listCameras() {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    const cameras = (await navigator.mediaDevices.enumerateDevices()).filter(
      (device) => device.kind === "videoinput",
    );
    setDevices(cameras);
    if (!deviceId && cameras[0]) setDeviceId(cameras[0].deviceId);
  }
  async function startCamera() {
    if (!navigator.mediaDevices?.getUserMedia) {
      setStatus(
        "Camera access needs a secure address (HTTPS or localhost). Open this dashboard at localhost, not through a network IP.",
      );
      return;
    }
    try {
      // Requesting any available camera works on laptops and desktops. Requiring
      // an "environment" camera fails on devices that only have a front webcam.
      const video = deviceId ? { deviceId: { exact: deviceId } } : true;
      const stream = await navigator.mediaDevices.getUserMedia({
        video,
        audio: false,
      });
      streamRef.current = stream;
      setCameraOn(true);
      setStatus(
        "Camera ready. Start monitoring to analyze live frames continuously.",
      );
      listCameras();
    } catch (error) {
      const messages = {
        NotAllowedError:
          "Camera permission was blocked. Select the lock/camera icon beside the address bar, allow camera access, then try again.",
        NotFoundError:
          "No camera was found. Connect a webcam and make sure no privacy switch is disabling it.",
        NotReadableError:
          "Your camera is in use by another app. Close Zoom, Teams, or another camera app and try again.",
      };
      setStatus(
        messages[error.name] ||
          `Camera could not start (${error.name || "unknown error"}).`,
      );
    }
  }
  async function analyze(blob, name = "camera.jpg") {
    if (busyRef.current) return;
    busyRef.current = true;
    setLoading(true);
    setStatus("Analyzing image with the fire and smoke model…");
    const data = new FormData();
    data.append("image", blob, name);
    try {
      const response = await fetch(
        `${API}/api/detect?confidence=${confidence}`,
        { method: "POST", body: data },
      );
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.detail || "Analysis failed");
      setResult(payload);
      setStatus(
        payload.detections.length
          ? `${payload.detections.length} potential hazard(s) found.`
          : "No fire or smoke detected in this image.",
      );
      loadAlerts();
    } catch (error) {
      setStatus(`Could not analyze: ${error.message}. Is the API running?`);
    } finally {
      setLoading(false);
      busyRef.current = false;
    }
  }
  function capture() {
    const video = videoRef.current;
    if (!video?.videoWidth) return;
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext("2d").drawImage(video, 0, 0);
    canvas.toBlob((blob) => analyze(blob), "image/jpeg", 0.9);
  }
  function startBrowserMonitoring() {
    if (!cameraOn) return;
    monitorRef.current = true;
    setMonitoring(true);
    setStatus("Live monitoring is active. Alerts are saved automatically.");
    const next = () => {
      if (!monitorRef.current) return;
      const video = videoRef.current;
      if (video?.videoWidth && !busyRef.current) {
        const canvas = document.createElement("canvas");
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        canvas.getContext("2d").drawImage(video, 0, 0);
        canvas.toBlob(
          (blob) => analyze(blob, "live-camera.jpg"),
          "image/jpeg",
          0.85,
        );
      }
      window.setTimeout(next, 1500);
    };
    next();
  }
  function startNetworkMonitoring() {
    if (!networkSource.trim()) {
      setStatus("Enter the ESP32-CAM, RTSP, or camera stream URL first.");
      return;
    }
    stopCamera();
    setStreamUrl(
      `${API}/api/stream?source=${encodeURIComponent(networkSource.trim())}&confidence=${confidence}`,
    );
    setMonitoring(true);
    setStatus(
      "Live network camera monitoring is active. Alerts are saved automatically.",
    );
  }
  function chooseFile(event) {
    const selected = event.target.files?.[0];
    if (!selected) return;
    setFile(selected);
    setResult(null);
    setStatus(`Ready to inspect ${selected.name}.`);
  }
  const danger = result?.detections.some((d) =>
    ["fire", "smoke"].includes(d.label.toLowerCase()),
  );

  return (
    <main>
      <header>
        <div className="brand">
          <span>◈</span> FIREWATCH <small>AI</small>
        </div>
        <div className="system">
          <i></i> SYSTEM ONLINE
        </div>
      </header>
      <section className="hero">
        <p className="eyebrow">REAL-TIME EARLY WARNING</p>
        <h1>See danger before it spreads.</h1>
        <p>
          Inspect camera frames and images with your trained fire and smoke
          detection model.
        </p>
      </section>
      <section className="workspace">
        <div className="panel capture">
          <div className="panel-title">
            <span>LIVE MONITORING</span>
            <b>{monitoring ? "● MONITORING" : "STANDBY"}</b>
          </div>
          {streamUrl ? (
            <img
              className="live-stream"
              src={streamUrl}
              alt="Live annotated camera feed"
            />
          ) : cameraOn ? (
            <video ref={videoRef} autoPlay playsInline muted />
          ) : (
            <div className="empty">
              <div className="camera-icon">⌁</div>
              <h3>Visual monitoring</h3>
              <p>Choose a camera source and start live monitoring.</p>
            </div>
          )}
          <div className="source-controls">
            <label>
              Camera source
              <select
                value={sourceType}
                onChange={(e) => {
                  stopCamera();
                  setSourceType(e.target.value);
                }}
              >
                <option value="browser">This computer's camera</option>
                <option value="webcam">Computer webcam index</option>
                <option value="esp32">ESP32-CAM / IP camera URL</option>
              </select>
            </label>
            {sourceType === "browser" && (
              <label>
                Available camera
                <select
                  value={deviceId}
                  onChange={(e) => setDeviceId(e.target.value)}
                >
                  {devices.map((device, i) => (
                    <option key={device.deviceId} value={device.deviceId}>
                      {device.label || `Camera ${i + 1}`}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {sourceType === "webcam" && (
              <label>
                Webcam index
                <input
                  value={networkSource}
                  onChange={(e) => setNetworkSource(e.target.value)}
                  placeholder="0"
                  inputMode="numeric"
                />
              </label>
            )}
            {sourceType === "esp32" && (
              <label>
                Stream URL
                <input
                  value={networkSource}
                  onChange={(e) => setNetworkSource(e.target.value)}
                  placeholder="http://192.168.1.50:81/stream"
                />
              </label>
            )}
          </div>
          <div className="actions">
            <label className="button secondary">
              Upload image
              <input
                type="file"
                accept="image/*"
                onChange={chooseFile}
                hidden
              />
            </label>
            {sourceType === "browser" ? (
              cameraOn ? (
                <>
                  <button
                    className="button"
                    onClick={monitoring ? stopCamera : startBrowserMonitoring}
                  >
                    {monitoring ? "Stop monitoring" : "Start monitoring"}
                  </button>
                  <button className="text-button" onClick={capture}>
                    Analyze one frame
                  </button>
                </>
              ) : (
                <button className="button" onClick={startCamera}>
                  Connect camera
                </button>
              )
            ) : (
              <button
                className="button"
                onClick={monitoring ? stopCamera : startNetworkMonitoring}
              >
                {monitoring ? "Stop monitoring" : "Start monitoring"}
              </button>
            )}
          </div>
          {file && (
            <button
              disabled={loading}
              className="analyze"
              onClick={() => analyze(file, file.name)}
            >
              {loading ? "ANALYZING…" : "ANALYZE SELECTED IMAGE"}
            </button>
          )}
        </div>
        <div className="panel result">
          <div className="panel-title">
            <span>ANALYSIS RESULT</span>
            {result && (
              <b className={danger ? "danger" : "safe"}>
                {danger ? "ATTENTION REQUIRED" : "CLEAR"}
              </b>
            )}
          </div>
          {result ? (
            <>
              <img src={result.preview} alt="Annotated detection" />
              <div className="detections">
                {result.detections.length ? (
                  result.detections.map((d, i) => (
                    <div key={i} className={d.label.toLowerCase()}>
                      <strong>{d.label}</strong>
                      <span>{Math.round(d.confidence * 100)}% confidence</span>
                    </div>
                  ))
                ) : (
                  <p>No detections above threshold.</p>
                )}
              </div>
            </>
          ) : (
            <div className="empty">
              <div className="radar">◌</div>
              <h3>Awaiting scan</h3>
              <p>{status}</p>
            </div>
          )}
        </div>
      </section>
      <section className="controls">
        <div>
          <label>
            Detection confidence{" "}
            <strong>{Math.round(confidence * 100)}%</strong>
          </label>
          <input
            type="range"
            min="0.05"
            max="0.95"
            step="0.05"
            value={confidence}
            onChange={(e) => setConfidence(Number(e.target.value))}
          />
          <small>
            Higher values reduce false alarms but may miss subtle smoke.
          </small>
        </div>
        <p className={danger ? "danger-copy" : ""}>{status}</p>
      </section>
      <section className="history">
        <div className="history-head">
          <h2>Recent incident log</h2>
          <button className="text-button" onClick={loadAlerts}>
            Refresh
          </button>
        </div>
        {alerts.length ? (
          <div className="table">
            <div className="row headings">
              <span>TIME</span>
              <span>TYPE</span>
              <span>COUNT</span>
              <span>CONFIDENCE</span>
            </div>
            {alerts.slice(0, 6).map((a, i) => (
              <div className="row" key={i}>
                <span>{a.timestamp}</span>
                <span className={a.class}>{a.class}</span>
                <span>{a.count}</span>
                <span>{Math.round(Number(a.max_confidence) * 100)}%</span>
              </div>
            ))}
          </div>
        ) : (
          <p className="muted">No saved alerts yet.</p>
        )}
      </section>
    </main>
  );
}
