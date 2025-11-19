# Check if Docker Desktop process is running and provide helpful instructions
$proc = Get-Process -Name "Docker Desktop" -ErrorAction SilentlyContinue
if ($proc) {
  Write-Host "Docker Desktop seems to be running (PID: $($proc.Id)). You can build the image now:"
  Write-Host "docker build -t doancosoweb:local ."
} else {
  Write-Host "Docker Desktop does not appear to be running. Please start Docker Desktop from the Start Menu and wait until it's 'Running'."
  Write-Host "If you want to start it from PowerShell (may require admin), run:"
  Write-Host "Start-Process 'C:\Program Files\Docker\Docker\Docker Desktop.exe'"
}
