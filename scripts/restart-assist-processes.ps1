$ErrorActionPreference = 'Stop'
$py = 'c:\apps\remote-assist-launcher\bundled-runtime\win\python-runtime\python.exe'
$wd = 'c:\apps\remote-assist-launcher\assist-bundle'
$settingsPath = 'C:\Users\Administrator\AppData\Roaming\remote-assist-launcher\settings.json'

Get-CimInstance Win32_Process -Filter "name='python.exe'" |
  Where-Object { $_.CommandLine -match 'remote_assist' } |
  ForEach-Object {
    Write-Host "Stopping PID $($_.ProcessId)"
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
  }
Start-Sleep -Seconds 2

$s = Get-Content $settingsPath -Raw | ConvertFrom-Json
$fps = [int]$s.fps
$q = [int]$s.quality
$mw = [int]$s.maxWidth
$room = [string]$s.roomId
$sec = [string]$s.secret
$relay = [string]$s.relayUrl
if (-not $relay) { $relay = 'ws://127.0.0.1:8765' }
$jss = 0
if ($null -ne $s.jpegSubsampling) { $jss = [int]$s.jpegSubsampling }
if ($jss -ne 0) { $jss = 2 }

Write-Host 'Starting remote_assist.server...'
Remove-Item Env:\REMOTE_ASSIST_FILES_DIR -ErrorAction SilentlyContinue
Start-Process -FilePath $py -ArgumentList @('-m', 'remote_assist.server') -WorkingDirectory $wd -WindowStyle Hidden
Start-Sleep -Seconds 3

Write-Host "Starting host_agent (fps=$fps quality=$q maxWidth=$mw jpeg=$jss)..."
$args = @(
  '-m', 'remote_assist.host_agent',
  '--relay', $relay,
  '--room', $room,
  '--secret', $sec,
  '--fps', "$fps",
  '--quality', "$q",
  '--max-width', "$mw",
  '--jpeg-subsampling', "$jss"
)
Remove-Item Env:\REMOTE_ASSIST_FILES_DIR -ErrorAction SilentlyContinue
Start-Process -FilePath $py -ArgumentList $args -WorkingDirectory $wd -WindowStyle Hidden
Start-Sleep -Seconds 2

try {
  $r = Invoke-WebRequest -Uri 'http://127.0.0.1:8765/' -UseBasicParsing -TimeoutSec 8
  Write-Host "Local check OK: HTTP $($r.StatusCode)"
} catch {
  Write-Host "Local check failed: $($_.Exception.Message)"
  exit 1
}

Write-Host 'Done.'
