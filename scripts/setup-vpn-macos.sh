#!/usr/bin/env bash
set -euo pipefail

provider="${1:-Windscribe}"
provider_lower="$(printf '%s' "$provider" | tr '[:upper:]' '[:lower:]')"
case "$provider_lower" in
  windscribe)
    cask="windscribe"
    app_name="Windscribe"
    setup_note="Sign in, select Netherlands, set Firewall Mode to Always on, and disable split tunnelling."
    ;;
  protonvpn|proton)
    cask="protonvpn"
    app_name="ProtonVPN"
    setup_note="Sign in, enable Kill switch, disable split tunnelling, and connect. The free plan may choose the exit country automatically."
    ;;
  *)
    echo "Use Windscribe or ProtonVPN." >&2
    exit 1
    ;;
esac

if ! command -v brew >/dev/null 2>&1; then
  open https://brew.sh/
  echo "Homebrew is required for verified package installation. Install it from the opened official page, then run this command again." >&2
  exit 1
fi

if brew list --cask "$cask" >/dev/null 2>&1; then
  echo "$app_name is already installed."
else
  echo "Installing the official $app_name macOS client..."
  brew install --cask "$cask"
fi

open -a "$app_name"
echo
echo "One-time private setup required:"
echo "1. $setup_note"
echo "2. Allow the VPN configuration when macOS asks."
echo "3. Leave auto-connect enabled for later private launches."
echo "4. Run: npm run vpn:check:mac"
echo "5. Start Northbound with: npm run dev:private:mac"
echo
echo "Northbound never stores or reads your VPN username or password."
