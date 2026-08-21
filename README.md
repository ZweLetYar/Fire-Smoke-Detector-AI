# FireWatch AI Web Dashboard

FireWatch AI is a fire and smoke detection dashboard. It combines a FastAPI inference API with a React and TypeScript frontend that uses the existing `best.pt` model.

## Requirements

- Python 3.10 or newer
- Node.js and npm
- A browser with camera access, when using a local or webcam source

## Quick start

From the project root, install the dependencies:

```powershell
python -m pip install -r requirements.txt
cd web
npm install
cd ..
```

Start both services with the included PowerShell script:

```powershell
./start.ps1
```

The API runs at `http://localhost:8000` and the dashboard runs at `http://localhost:5173`.

## Start services separately

Start the API:

```powershell
python -m uvicorn app:app --host 0.0.0.0 --port 8000
```

In another terminal, start the TypeScript frontend:

```powershell
cd web
npm run dev
```

## Frontend

The frontend source is in `web/src/`:

- `App.tsx` contains the dashboard and camera/detection workflows.
- `main.tsx` mounts the React application.
- `styles.css` contains the dashboard styles.
- `tsconfig.json` enables strict TypeScript checking with no JavaScript files included.

To validate the TypeScript source without emitting files:

```powershell
cd web
npx tsc --noEmit
```

To create a production build:

```powershell
cd web
npm run build
```

The dashboard lets you upload an image or capture a browser-camera frame, adjust the confidence threshold, view annotated detections, and review the detector's existing CSV alert log.

## API configuration

By default, the dashboard calls the API on port `8000` using the current browser hostname. To deploy the UI separately, set `VITE_API_URL` to the API's public base URL before starting or building the frontend:

```powershell
$env:VITE_API_URL = "http://localhost:8000"
npm run build
```
