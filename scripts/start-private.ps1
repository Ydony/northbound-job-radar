[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$projectDirectory = Split-Path -Parent $PSScriptRoot
$checkScript = Join-Path $PSScriptRoot 'check-vpn.ps1'

function Test-VpnRoute {
  try {
    & $checkScript -Quiet
    return $true
  }
  catch {
    return $false
  }
}

if (-not (Test-VpnRoute)) {
  $knownClients = @(
    (Join-Path $env:ProgramFiles 'Windscribe\Windscribe.exe'),
    (Join-Path $env:ProgramFiles 'Proton\VPN\ProtonVPN.Launcher.exe')
  )
  $clientPath = $knownClients | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
  $vpnApp = if (-not $clientPath) { Get-StartApps | Where-Object { $_.Name -match 'Windscribe|Proton VPN|Cloudflare WARP' } | Select-Object -First 1 } else { $null }
  if ($clientPath -or $vpnApp) {
    $clientName = if ($clientPath) { [IO.Path]::GetFileNameWithoutExtension($clientPath) } else { $vpnApp.Name }
    Write-Host "Starting $clientName and waiting for a full VPN route..." -ForegroundColor Cyan
    if ($clientPath) { Start-Process -FilePath $clientPath } else { Start-Process explorer.exe "shell:AppsFolder\$($vpnApp.AppID)" }
    for ($attempt = 0; $attempt -lt 20 -and -not (Test-VpnRoute); $attempt += 1) {
      Start-Sleep -Seconds 2
    }
  }
}

if (-not (Test-VpnRoute)) {
  throw 'Northbound was not started because no full VPN route is active. Connect the VPN, disable split tunneling, and run npm run dev:private again.'
}

& $checkScript -ShowPublicIp
Set-Location -LiteralPath $projectDirectory
& npm run dev
exit $LASTEXITCODE
