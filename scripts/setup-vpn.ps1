[CmdletBinding()]
param(
  [ValidateSet('Windscribe', 'ProtonVPN')]
  [string]$Provider = 'Windscribe'
)

$ErrorActionPreference = 'Stop'

$providers = @{
  Windscribe = @{
    PackageId = 'Windscribe.Windscribe'
    DisplayName = 'Windscribe'
    SetupNote = 'Create or sign in to the free account, select Netherlands, enable Firewall, and disable split tunneling.'
  }
  ProtonVPN = @{
    PackageId = 'Proton.ProtonVPN'
    DisplayName = 'Proton VPN'
    SetupNote = 'Create or sign in to the free account, enable Advanced kill switch, and connect. The free plan may choose the exit country automatically.'
  }
}

if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
  throw 'Windows Package Manager (winget) is required. Install or update App Installer from Microsoft Store, then run this command again.'
}

$selected = $providers[$Provider]
Write-Host "Checking $($selected.DisplayName)..."
& winget list --exact --id $selected.PackageId --accept-source-agreements | Out-Null
$isInstalled = $LASTEXITCODE -eq 0

if (-not $isInstalled) {
  Write-Host "Installing the official $($selected.DisplayName) Windows client..." -ForegroundColor Cyan
  & winget install --exact --id $selected.PackageId --source winget --accept-package-agreements --accept-source-agreements
  if ($LASTEXITCODE -ne 0) {
    throw "$($selected.DisplayName) installation did not complete successfully."
  }
}
else {
  Write-Host "$($selected.DisplayName) is already installed." -ForegroundColor Green
}

$startApp = Get-StartApps | Where-Object { $_.Name -like "*$($selected.DisplayName)*" } | Select-Object -First 1
if ($startApp) {
  Start-Process explorer.exe "shell:AppsFolder\$($startApp.AppID)"
}

Write-Host ''
Write-Host 'One-time private setup required:' -ForegroundColor Yellow
Write-Host "1. $($selected.SetupNote)"
Write-Host '2. Leave auto-connect enabled so the private launcher can reconnect on later runs.'
Write-Host '3. Run: npm run vpn:check'
Write-Host '4. Start Northbound with: npm run dev:private'
Write-Host ''
Write-Host 'Northbound never stores or reads your VPN username or password.'
