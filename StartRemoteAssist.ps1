$ErrorActionPreference = 'SilentlyContinue'
$remoteAssistDir = 'C:\Users\Administrator\Documents\Codex\2026-05-09\todesk'

Write-Host 'Starting Remote Assist...' -ForegroundColor Cyan

$serviceName = 'cloudflared-hemei-tunnel'
$service = Get-Service $serviceName
if ($service.Status -ne 'Running') {
  Write-Host 'Starting cloudflared tunnel...'
  Start-Service $serviceName
  Start-Sleep -Seconds 3
}

$server = Get-CimInstance Win32_Process | Where-Object {
  $_.Name -eq 'python.exe' -and $_.CommandLine -like '*remote_assist.server*'
}
if (-not $server) {
  Write-Host 'Starting local remote console...'
  Start-Process -FilePath 'C:\Python314\python.exe' -ArgumentList '-m remote_assist.server' -WorkingDirectory $remoteAssistDir -WindowStyle Hidden
  Start-Sleep -Seconds 3
}

$hostAgent = Get-CimInstance Win32_Process | Where-Object {
  $_.Name -eq 'python.exe' -and $_.CommandLine -like '*remote_assist.host_agent*'
}
if (-not $hostAgent) {
  Write-Host 'Starting host agent...'
  Start-Process -FilePath 'C:\Python314\python.exe' -ArgumentList '-m remote_assist.host_agent --relay ws://127.0.0.1:8765 --room CODEX2026 --secret ASSIST2026 --fps 8 --quality 45 --max-width 0' -WorkingDirectory $remoteAssistDir -WindowStyle Hidden
  Start-Sleep -Seconds 3
}

$localOk = $false
for ($i = 0; $i -lt 8 -and -not $localOk; $i++) {
  try {
    $localResponse = Invoke-WebRequest 'http://127.0.0.1:8765/' -UseBasicParsing -TimeoutSec 5
    $localOk = ($localResponse.StatusCode -eq 200)
  } catch {
    Start-Sleep -Seconds 2
  }
}

$remoteOk = $false
for ($i = 0; $i -lt 5 -and -not $remoteOk; $i++) {
  try {
    $remoteResponse = Invoke-WebRequest 'https://remote.hemei.asia/' -UseBasicParsing -TimeoutSec 8
    $remoteOk = ($remoteResponse.StatusCode -eq 200)
  } catch {
    Start-Sleep -Seconds 2
  }
}

if ($localOk -and $remoteOk) {
  Write-Host 'Remote Assist is ready.' -ForegroundColor Green
  Write-Host 'Open this URL from the other computer: https://remote.hemei.asia/' -ForegroundColor Green
  Start-Process 'https://remote.hemei.asia/'
} else {
  Write-Host 'Startup check failed. Please send a screenshot of this window.' -ForegroundColor Red
  Write-Host "Local console OK: $localOk"
  Write-Host "Remote URL OK: $remoteOk"
}
