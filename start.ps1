$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$apiPort = 8000
$frontPort = 5173

foreach ($port in @($apiPort, $frontPort)) {
    $pids = Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue |
        Select-Object -ExpandProperty OwningProcess -Unique

    foreach ($pid in $pids) {
        if ($pid) {
            Stop-Process -Id $pid -Force -ErrorAction SilentlyContinue
        }
    }
}

Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$root'; python -m uvicorn app:app --host 0.0.0.0 --port $apiPort"
Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$root\web'; npx vite --host 0.0.0.0 --port $frontPort"