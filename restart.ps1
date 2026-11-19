# Stops the demo server started by start.cmd, then starts it again so a changed .env.local is loaded.
$ErrorActionPreference = 'Stop'
$demoUrl = 'http://127.0.0.1:8787'
$pidFile = Join-Path $PSScriptRoot '.data/server.pid'
if (Test-Path -LiteralPath $pidFile) {
  $serverPid = [int]((Get-Content -LiteralPath $pidFile -Raw).Trim())
  $process = Get-CimInstance Win32_Process -Filter "ProcessId = $serverPid" -ErrorAction SilentlyContinue
  # Only stop the process if it really is this demo server (PIDs can be reused by Windows).
  if ($process -and $process.CommandLine -like '*server/index.mjs*') {
    Stop-Process -Id $serverPid -Force
    Start-Sleep -Milliseconds 800
  }
  Remove-Item -LiteralPath $pidFile -Force
}
$stillRunning = $false
try { Invoke-RestMethod -Uri ($demoUrl + '/api/session') -TimeoutSec 2 | Out-Null; $stillRunning = $true } catch { }
if ($stillRunning) { throw 'A server started with "npm start" is still running. Press Ctrl+C in that terminal, then run restart.cmd again.' }
& (Join-Path $PSScriptRoot 'start.ps1')
