# Starts the app on a fixed port (5600) using nodemon if available
$port = 5600
Write-Output "Starting server on port $port..."
$env:PORT = $port
# Start nodemon if installed, otherwise node
if (Get-Command nodemon -ErrorAction SilentlyContinue) {
  Start-Process -NoNewWindow -FilePath "nodemon" -ArgumentList "server.js" -WorkingDirectory (Get-Location)
} else {
  Start-Process -NoNewWindow -FilePath "node" -ArgumentList "server.js" -WorkingDirectory (Get-Location)
}
Write-Output "Server process started. Open http://localhost:$port/"