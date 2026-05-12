# 强制重启 cloudflared 命名隧道服务，修复浏览器访问固定域名时出现 Cloudflare Error 1033（连接器假死）。
# 建议：右键「以管理员身份运行」PowerShell，再执行：
#   Set-ExecutionPolicy Bypass -Scope Process -Force
#   & "C:\apps\remote-assist-launcher\scripts\restart-hemei-tunnel.ps1"
param(
  [string]$ServiceName = 'cloudflared-hemei-tunnel'
)

$ErrorActionPreference = 'Continue'
Write-Host "Stopping service: $ServiceName" -ForegroundColor Cyan
try { Stop-Service -Name $ServiceName -Force } catch { Write-Host $_.Exception.Message }
Start-Sleep -Seconds 2

Write-Host 'Stopping any cloudflared.exe processes...' -ForegroundColor Cyan
Get-Process -Name cloudflared -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2

Write-Host "Starting service: $ServiceName" -ForegroundColor Cyan
try {
  Start-Service -Name $ServiceName
  Start-Sleep -Seconds 6
  $s = Get-Service -Name $ServiceName
  Write-Host ("Service status: {0}" -f $s.Status) -ForegroundColor Green
} catch {
  Write-Host ('Failed to start service: ' + $_.Exception.Message) -ForegroundColor Red
  exit 1
}

Write-Host 'Testing https://remote.hemei.asia/ ...' -ForegroundColor Cyan
try {
  $r = Invoke-WebRequest -Uri 'https://remote.hemei.asia/' -UseBasicParsing -TimeoutSec 20
  if ($r.StatusCode -eq 200 -and $r.Content -notmatch '1033') {
    Write-Host 'OK: fixed domain returns HTTP 200.' -ForegroundColor Green
  } else {
    Write-Host ('Unexpected: status ' + $r.StatusCode) -ForegroundColor Yellow
  }
} catch {
  Write-Host ('HTTP test failed: ' + $_.Exception.Message) -ForegroundColor Yellow
}
