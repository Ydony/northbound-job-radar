#!/usr/bin/env bash
set -euo pipefail

project_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
check_script="$project_directory/scripts/check-vpn-macos.sh"

vpn_is_ready() {
  "$check_script" >/dev/null 2>&1
}

if ! vpn_is_ready; then
  if [[ -d /Applications/Windscribe.app ]]; then
    echo "Starting Windscribe and waiting for a full VPN route..."
    open -a Windscribe
  elif [[ -d /Applications/ProtonVPN.app ]]; then
    echo "Starting ProtonVPN and waiting for a full VPN route..."
    open -a ProtonVPN
  fi

  for _attempt in {1..20}; do
    vpn_is_ready && break
    sleep 2
  done
fi

if ! vpn_is_ready; then
  echo "Northbound was not started because no full VPN route is active. Connect the VPN, disable split tunnelling, and run VPN_ENFORCED=true npm run dev:private:mac again." >&2
  exit 1
fi

"$check_script" --show-public-ip
cd "$project_directory"
npm run dev
