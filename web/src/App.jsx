import { useEffect, useRef, useState } from "react";

const API =
  import.meta.env.VITE_API_URL ||
  `${window.location.protocol}//${window.location.hostname}:8000`;

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
  const [monitorFps, setMonitorFps] = useState(0);
  const [monitoring, setMonitoring] = useState(false);
  const [soundEnabled, setSoundEnabled] = useState(false);
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const monitorRef = useRef(false);
  const busyRef = useRef(false);
  const fpsRef = useRef({ frames: 0, startedAt: 0 });
  const audioContextRef = useRef(null);
  const lastSoundAtRef = useRef(0);

  const loadAlerts = async () => {
    try {
      const response = await fetch(`${API}/api/alerts`);
      if (!response.ok) throw new Error(`API returned ${response.status}`);
      setAlerts(await response.json());
    } catch (error) {
      setStatus(`Could not load recent alerts: ${error.message}.`);
    }
  };

  useEffect(() => {
    loadAlerts();
    listCameras();
    return () => {
      stopCamera();
      audioContextRef.current?.close();
    };
  }, []);

  useEffect(() => {
    if (cameraOn && videoRef.current && streamRef.current) {
      videoRef.current.srcObject = streamRef.current;
    }
  }, [cameraOn]);

  useEffect(() => {
    if (!monitoring || !streamUrl) return undefined;
    let latestAlertKey = "";

    const checkNetworkAlerts = async () => {
      try {
        const response = await fetch(`${API}/api/alerts`);
        if (!response.ok) return;
        const latest = (await response.json())[0];
        if (!latest) return;
        const alertKey = `${latest.timestamp}:${latest.snapshot}`;
        if (!latestAlertKey) {
          latestAlertKey = alertKey;
          return;
        }
        if (alertKey === latestAlertKey) return;
        latestAlertKey = alertKey;
        if (["fire", "smoke"].includes(latest.class.toLowerCase())) {
          playDetectionAlert();
        }
      } catch {}
    };

    checkNetworkAlerts();
    const interval = window.setInterval(checkNetworkAlerts, 2000);
    return () => window.clearInterval(interval);
  }, [monitoring, streamUrl, soundEnabled]);

  function stopCamera() {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    setCameraOn(false);
    monitorRef.current = false;
    setMonitoring(false);
    setStreamUrl("");
    setMonitorFps(0);
    fpsRef.current = { frames: 0, startedAt: 0 };
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

  async function activateSound(playTestTone = false) {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) {
      return false;
    }

    try {
      const existingContext = audioContextRef.current;
      const audioContext =
        !existingContext || existingContext.state === "closed"
          ? new AudioContext()
          : existingContext;
      audioContextRef.current = audioContext;
      await audioContext.resume();
      setSoundEnabled(true);
      if (playTestTone) playDetectionAlert(audioContext, true);
      return true;
    } catch (error) {
      setStatus(`Sound alerts could not start: ${error.message}.`);
      return false;
    }
  }

  async function toggleSound() {
    if (soundEnabled) {
      setSoundEnabled(false);
      setStatus("Sound alerts muted.");
      return;
    }

    const enabled = await activateSound(true);
    if (enabled) setStatus("Sound alerts enabled for automatic detections.");
  }

  function playDetectionAlert(
    audioContext = audioContextRef.current,
    force = false,
  ) {
    if ((!soundEnabled && !force) || !audioContext) return;
    const now = performance.now();
    if (!force && now - lastSoundAtRef.current < 5000) return;
    lastSoundAtRef.current = now;

    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();
    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(880, audioContext.currentTime);
    oscillator.frequency.setValueAtTime(660, audioContext.currentTime + 0.16);
    gain.gain.setValueAtTime(0.0001, audioContext.currentTime);
    gain.gain.exponentialRampToValueAtTime(
      0.3,
      audioContext.currentTime + 0.02,
    );
    gain.gain.exponentialRampToValueAtTime(
      0.0001,
      audioContext.currentTime + 0.34,
    );
    oscillator.connect(gain).connect(audioContext.destination);
    oscillator.start();
    oscillator.stop(audioContext.currentTime + 0.34);
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
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.detail || "Analysis failed");

      setResult(payload);
      if (
        payload.detections.some((d) =>
          ["fire", "smoke"].includes(d.label.toLowerCase()),
        )
      ) {
        playDetectionAlert();
      }
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
    activateSound();
    monitorRef.current = true;
    setMonitoring(true);
    fpsRef.current = { frames: 0, startedAt: performance.now() };
    setStatus("Live monitoring is active. Alerts are saved automatically.");

    const next = () => {
      if (!monitorRef.current) return;

      const video = videoRef.current;
      if (video?.videoWidth) {
        fpsRef.current.frames += 1;
        const elapsed = performance.now() - fpsRef.current.startedAt;
        if (elapsed >= 1000) {
          setMonitorFps((fpsRef.current.frames * 1000) / elapsed);
          fpsRef.current = { frames: 0, startedAt: performance.now() };
        }
      }
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

    activateSound();
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
    activateSound();
    setFile(selected);
    setResult(null);
    setStatus(`Ready to inspect ${selected.name}.`);
  }

  const danger = result?.detections.some((d) =>
    ["fire", "smoke"].includes(d.label.toLowerCase()),
  );

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand" aria-label="FireWatch AI brand">
          <span>◈</span>
          <div>
            FIREWATCH <small>AI</small>
          </div>
        </div>

        <div className="topbar-actions">
          <div className="status-pill online">
            <i className="status-dot" />
            SYSTEM ONLINE
          </div>
          <button className="ghost-button" onClick={loadAlerts}>
            Refresh alerts
          </button>
          <button
            className={`sound-toggle ${soundEnabled ? "enabled" : ""}`}
            onClick={toggleSound}
            aria-pressed={soundEnabled}
          >
            {soundEnabled ? "Sound alerts on" : "Enable sound alerts"}
          </button>
        </div>
      </header>

      <section className="dashboard-grid">
        <div className="monitor-column">
          <div className="panel monitor-panel">
            <div className="panel-header">
              <div>
                <span className="eyebrow">LIVE CITY MONITOR</span>
                <h2>Surveillance feed</h2>
              </div>
              <span
                className={`monitor-state ${monitoring ? "active" : "idle"}`}
              >
                {monitoring ? "MONITORING" : "STANDBY"}
              </span>
            </div>

            <div className="monitor-stage">
              {(monitoring || streamUrl) && (
                <div
                  className="monitor-fps"
                  aria-label="Monitoring frames per second"
                >
                  <i className="status-dot" />
                  {streamUrl ? "LIVE FEED" : "ANALYSIS"}{" "}
                  <strong>
                    {streamUrl
                      ? "shown on feed"
                      : `${monitorFps.toFixed(1)} FPS`}
                  </strong>
                </div>
              )}
              {streamUrl ? (
                <img
                  className="live-stream"
                  src={streamUrl}
                  alt="Live annotated camera feed"
                />
              ) : cameraOn ? (
                <video ref={videoRef} autoPlay playsInline muted />
              ) : (
                <div className="empty-state">
                  <div className="camera-icon">⌁</div>
                  <h3>Visual monitoring</h3>
                  <p>Choose a camera source and start live monitoring.</p>
                </div>
              )}
            </div>

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
                      className="button primary"
                      onClick={monitoring ? stopCamera : startBrowserMonitoring}
                    >
                      {monitoring ? "Stop monitoring" : "Start monitoring"}
                    </button>
                    <button className="text-button" onClick={capture}>
                      Analyze one frame
                    </button>
                  </>
                ) : (
                  <button className="button primary" onClick={startCamera}>
                    Connect camera
                  </button>
                )
              ) : (
                <button
                  className="button primary"
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
        </div>

        <aside className="sidebar">
          <div className="panel analysis-panel">
            <div className="panel-header">
              <div>
                <span className="eyebrow">ANALYSIS RESULT</span>
                <h3>Incident review</h3>
              </div>
              {result && (
                <span className={`status-tag ${danger ? "danger" : "safe"}`}>
                  {danger ? "ATTENTION" : "CLEAR"}
                </span>
              )}
            </div>

            {result ? (
              <>
                <img
                  src={result.preview}
                  alt="Annotated detection"
                  className="result-preview"
                />
                <div className="detections">
                  {result.detections.length ? (
                    result.detections.map((d, i) => (
                      <div
                        key={i}
                        className={`detection-item ${d.label.toLowerCase()}`}
                      >
                        <div>
                          <strong>{d.label}</strong>
                          <span>
                            {Math.round(d.confidence * 100)}% confidence
                          </span>
                        </div>
                        <span className="confidence-badge">
                          {Math.round(d.confidence * 100)}%
                        </span>
                      </div>
                    ))
                  ) : (
                    <p className="muted-copy">No detections above threshold.</p>
                  )}
                </div>
              </>
            ) : (
              <div className="empty-state compact">
                <div className="radar">◌</div>
                <h3>Awaiting scan</h3>
                <p>{status}</p>
              </div>
            )}
          </div>

          <div className="panel status-panel">
            <div className="panel-header compact-header">
              <div>
                <span className="eyebrow">SYSTEM STATUS</span>
                <h3>Detection settings</h3>
              </div>
            </div>

            <div className="metric-box">
              <label htmlFor="confidence-range">
                Confidence threshold{" "}
                <strong>{Math.round(confidence * 100)}%</strong>
              </label>
              <input
                id="confidence-range"
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

            <p className={`status-message ${danger ? "danger-copy" : ""}`}>
              {status}
            </p>
          </div>

          <div className="panel history-panel">
            <div className="panel-header compact-header">
              <div>
                <span className="eyebrow">INCIDENT LOG</span>
                <h3>Recent alerts</h3>
              </div>
            </div>

            {alerts[0]?.snapshot && (
              <div className="latest-alert">
                <div className="latest-alert-heading">
                  <div>
                    <span className="eyebrow">LATEST CAPTURE</span>
                    <h4>{alerts[0].class} detected</h4>
                  </div>
                  <span>{alerts[0].timestamp}</span>
                </div>
                <img
                  src={`${API}/api/alerts/${encodeURIComponent(alerts[0].snapshot)}`}
                  alt={`Latest ${alerts[0].class} detection`}
                />
                <div className="latest-alert-meta">
                  <span>
                    {alerts[0].count} object
                    {Number(alerts[0].count) === 1 ? "" : "s"}
                  </span>
                  <strong>
                    {Math.round(Number(alerts[0].max_confidence) * 100)}%
                    confidence
                  </strong>
                </div>
              </div>
            )}

            {alerts.length ? (
              <div className="table">
                <div className="row headings">
                  <span>TIME</span>
                  <span>TYPE</span>
                  <span>COUNT</span>
                  <span>CONF.</span>
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
              <p className="muted-copy">No saved alerts yet.</p>
            )}
          </div>
        </aside>
      </section>
    </main>
  );
}
