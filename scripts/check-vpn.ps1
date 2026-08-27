[CmdletBinding()]
param(
  [switch]$Quiet,
  [switch]$ShowPublicIp
)

$ErrorActionPreference = 'Stop'

$vpnNamePattern = 'Windscribe|Windtun|ProtonVPN|Proton VPN|WireGuard|Cloudflare WARP|WARP'
$adapters = @(Get-NetAdapter -IncludeHidden | Where-Object {
  $_.Status -eq 'Up' -and ($_.Name -match $vpnNamePattern -or $_.InterfaceDescription -match $vpnNamePattern)
})

if (-not $adapters.Count) {
  throw 'No active supported VPN adapter was detected. Connect Windscribe, Proton VPN, WireGuard, or Cloudflare WARP and try again.'
}

$adapterIndexes = @($adapters | ForEach-Object { $_.ifIndex })
$vpnRoutes = @(Get-NetRoute -AddressFamily IPv4 | Where-Object {
  $adapterIndexes -contains $_.InterfaceIndex
})
$routePrefixes = @($vpnRoutes | ForEach-Object { $_.DestinationPrefix })
$coversAllIpv4 = $routePrefixes -contains '0.0.0.0/0' -or (
  $routePrefixes -contains '0.0.0.0/1' -and $routePrefixes -contains '128.0.0.0/1'
)

if (-not $coversAllIpv4) {
  $names = ($adapters | ForEach-Object { $_.Name }) -join ', '
  throw "A VPN adapter is active ($names), but no full IPv4 tunnel route was found. Disable split tunneling or connect the VPN in full-tunnel mode."
}

if (-not $Quiet) {
  $names = ($adapters | ForEach-Object { $_.Name }) -join ', '
  Write-Host "VPN route detected: $names" -ForegroundColor Green
}

if ($ShowPublicIp) {
  try {
    $trace = (Invoke-WebRequest -UseBasicParsing -Uri 'https://www.cloudflare.com/cdn-cgi/trace' -TimeoutSec 10).Content
    $values = @{}
    foreach ($line in ($trace -split "`n")) {
      $parts = $line.Trim() -split '=', 2
      if ($parts.Count -eq 2) { $values[$parts[0]] = $parts[1] }
    }
    Write-Host "VPN exit IP: $($values.ip)  Country: $($values.loc)" -ForegroundColor Green
  }
  catch {
    Write-Warning 'The VPN route is active, but the optional public-IP check could not be completed.'
  }
}
