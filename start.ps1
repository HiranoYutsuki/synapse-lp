$ErrorActionPreference = 'Stop'
$demoUrl = 'http://127.0.0.1:8787'
try {
  $status = Invoke-RestMethod -Uri ($demoUrl + '/api/session') -TimeoutSec 2
  if ($status.model -like 'gemini-*') {
    Start-Process ($demoUrl + '/#demo')
    exit 0
  }
} catch { }

$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
if ($nodeCommand) { $nodePath = $nodeCommand.Source }
else { $nodePath = Join-Path $env:USERPROFILE '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe' }
if (-not (Test-Path -LiteralPath $nodePath)) { throw 'Node.js 24 LTS is required. Install it from https://nodejs.org/ and run this file again.' }
if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot '.env.local'))) { throw 'Copy .env.example to .env.local and set GEMINI_API_KEY before starting.' }
$logDirectory = Join-Path $PSScriptRoot '.data'
New-Item -ItemType Directory -Force -Path $logDirectory | Out-Null
$demoProcess = Start-Process -FilePath $nodePath -ArgumentList '--env-file-if-exists=.env.local','server/index.mjs' -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logDirectory 'server.log') -RedirectStandardError (Join-Path $logDirectory 'server-error.log') -PassThru
$demoProcess.Id | Set-Content -LiteralPath (Join-Path $logDirectory 'server.pid')
for ($attempt = 0; $attempt -lt 20; $attempt++) {
  try {
    $status = Invoke-RestMethod -Uri ($demoUrl + '/api/session') -TimeoutSec 1
    if ($status.model -like 'gemini-*') { Start-Process ($demoUrl + '/#demo'); exit 0 }
  } catch { Start-Sleep -Milliseconds 250 }
}
throw 'Server could not start. Read .data/server-error.log for details.'
