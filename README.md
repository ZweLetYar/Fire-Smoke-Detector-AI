# FireWatch AI Web Dashboard

This project now has a React front end (`web/`) and a FastAPI inference API (`app.py`) that uses the existing `best.pt` fire/smoke model.

## Start the API

```powershell
python -m pip install -r requirements.txt
python -m uvicorn app:app --host 0.0.0.0 --port 8000
```

## Start the React dashboard

Open another terminal:

```powershell
cd web
npm install
npm run dev
```

Open the address Vite prints (normally `http://localhost:5173`). The dashboard lets you upload an image or capture a browser-camera frame, adjust the confidence threshold, view annotated detections, and review the detector's existing CSV alert log.

To deploy the UI separately, set `VITE_API_URL` to your API's public base URL before building it.
