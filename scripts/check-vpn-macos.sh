#!/usr/bin/env bash
set -euo pipefail

show_public_ip=false
if [[ "${1:-}" == "--show-public-ip" ]]; then
  show_public_ip=true
fi

vpn_interfaces="$(ifconfig -l | tr ' ' '\n' | grep -E '^utun[0-9]+$' || true)"

if [[ -z "$vpn_interfaces" ]]; then
  echo "No active macOS VPN tunnel interface was detected." >&2
  exit 1
fi

route_table="$(netstat -rn -f inet)"
active_interface=""
while IFS= read -r interface; do
  has_default=false
  has_lower_half=false
  has_upper_half=false
  if awk -v iface="$interface" '$1 == "default" && $NF == iface { found = 1 } END { exit !found }' <<<"$route_table"; then has_default=true; fi
  if awk -v iface="$interface" '($1 == "0/1" || $1 == "0.0.0.0/1") && $NF == iface { found = 1 } END { exit !found }' <<<"$route_table"; then has_lower_half=true; fi
  if awk -v iface="$interface" '($1 == "128.0/1" || $1 == "128.0.0.0/1") && $NF == iface { found = 1 } END { exit !found }' <<<"$route_table"; then has_upper_half=true; fi
  if [[ "$has_default" == true || ("$has_lower_half" == true && "$has_upper_half" == true) ]]; then
    active_interface="$interface"
    break
  fi
done <<<"$vpn_interfaces"

if [[ -z "$active_interface" ]]; then
  echo "A macOS tunnel exists, but it does not carry a full IPv4 route. Disable split tunnelling and reconnect." >&2
  exit 1
fi

echo "VPN route detected: $active_interface"

if [[ "$show_public_ip" == true ]]; then
  trace="$(curl --fail --silent --show-error --max-time 10 https://www.cloudflare.com/cdn-cgi/trace || true)"
  exit_ip="$(awk -F= '$1 == "ip" { print $2 }' <<<"$trace")"
  exit_country="$(awk -F= '$1 == "loc" { print $2 }' <<<"$trace")"
  if [[ -n "$exit_ip" ]]; then
    echo "VPN exit IP: $exit_ip  Country: ${exit_country:-unknown}"
  else
    echo "The VPN route is active, but the optional public-IP check could not be completed." >&2
  fi
fi
