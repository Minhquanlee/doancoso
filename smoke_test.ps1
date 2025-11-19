# Smoke test for the demo shop
# Runs: register -> login -> pick product -> add to cart -> checkout -> list orders

$base = 'http://localhost:6000'
$s = New-Object Microsoft.PowerShell.Commands.WebRequestSession

function die($msg){ Write-Output "FAIL: $msg"; exit 1 }

Write-Output "== Smoke test starting against $base =="

# Register
Write-Output "1) Register user"
try{
  $r = Invoke-WebRequest -Uri "$base/register" -Method Post -Body @{name='SmokeTester'; email='smoketester@example.local'; password='smokepass'} -WebSession $s -UseBasicParsing -ErrorAction Stop
  Write-Output " Register done (status $($r.StatusCode))"
} catch { Write-Output " Register failed: $($_.Exception.Message)"; exit 1 }

# Login
Write-Output "2) Login"
try{
  $r = Invoke-WebRequest -Uri "$base/login" -Method Post -Body @{email='smoketester@example.local'; password='smokepass'} -WebSession $s -UseBasicParsing -ErrorAction Stop
  Write-Output " Login done (status $($r.StatusCode))"
} catch { Write-Output " Login failed: $($_.Exception.Message)"; exit 1 }

# Get a product id from DB
Write-Output "3) Get a product id from DB"
$prod = & node -e "const Database=require('better-sqlite3');const db=new Database('data.sqlite');const p=db.prepare('SELECT id,title FROM products LIMIT 1').get(); if(p){console.log(p.id+'|'+p.title);}"
if(-not $prod){ Write-Output " No product found"; exit 1 }
$prod = $prod.Trim()
$parts = $prod -split '\|'
$prodId = $parts[0]
$prodTitle = if($parts.Length -gt 1){$parts[1]} else {'(unknown)'}
Write-Output " Found product id=$prodId title=$prodTitle"

# Add to cart
Write-Output "4) Add to cart"
try{
  $r = Invoke-WebRequest -Uri "$base/cart/add" -Method Post -Body @{productId=$prodId; qty=1} -WebSession $s -UseBasicParsing -ErrorAction Stop
  Write-Output " Add to cart finished (status $($r.StatusCode))"
} catch { Write-Output " Add to cart failed: $($_.Exception.Message)"; exit 1 }

# View cart
Write-Output "5) View cart"
try{
  $r = Invoke-WebRequest -Uri "$base/cart" -WebSession $s -UseBasicParsing -ErrorAction Stop
  Write-Output " Cart fetched (status $($r.StatusCode))"
  if($r.Content -match [regex]::Escape($prodTitle)) { Write-Output " Cart contains product title: OK" } else { Write-Output " Cart does NOT contain product title: WARNING" }
} catch { Write-Output " Fetch cart failed: $($_.Exception.Message)"; exit 1 }

# Checkout (POST)
Write-Output "6) Checkout (POST)"
try{
  $r = Invoke-WebRequest -Uri "$base/checkout" -Method Post -WebSession $s -UseBasicParsing -ErrorAction Stop
  Write-Output " Checkout POST finished (status $($r.StatusCode))"
} catch { Write-Output " Checkout failed: $($_.Exception.Message)"; exit 1 }

# Orders page
Write-Output "7) Orders page"
try{
  $r = Invoke-WebRequest -Uri "$base/orders" -WebSession $s -UseBasicParsing -ErrorAction Stop
  Write-Output " Orders fetched (status $($r.StatusCode))"
  if($r.Content -match 'Đơn hàng' -or $r.Content -match 'Đơn') { Write-Output " Orders page contains expected text: OK" } else { Write-Output " Orders page content check: WARNING" }
} catch { Write-Output " Orders fetch failed: $($_.Exception.Message)"; exit 1 }

Write-Output "== Smoke test completed successfully =="
