$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$restartAssist = Join-Path $root 'scripts\restart-assist-processes.ps1'

Write-Host 'Starting Remote Assist...' -ForegroundColor Cyan

$serviceName = 'cloudflared-hemei-tunnel'
try {
  $service = Get-Service -Name $serviceName -ErrorAction Stop
  if ($service.Status -ne 'Running') {
    Write-Host 'Starting cloudflared tunnel...'
    Start-Service -Name $serviceName
    Start-Sleep -Seconds 3
  }
} catch {
  Write-Host "Cloudflared service not started: $($_.Exception.Message)" -ForegroundColor Yellow
}

& $restartAssist

try {
  $remoteResponse = Invoke-WebRequest 'https://remote.hemei.asia/' -UseBasicParsing -TimeoutSec 15
  if ($remoteResponse.StatusCode -eq 200) {
    Write-Host 'Remote Assist is ready.' -ForegroundColor Green
    Write-Host 'Open this URL from the other computer: https://remote.hemei.asia/' -ForegroundColor Green
    Start-Process 'https://remote.hemei.asia/'
    exit 0
  }
} catch {
  Write-Host ('Remote URL check failed: ' + $_.Exception.Message) -ForegroundColor Yellow
}

Write-Host 'Local service is running, but the public URL check failed. Check cloudflared if the other computer cannot open it.' -ForegroundColor Yellow
