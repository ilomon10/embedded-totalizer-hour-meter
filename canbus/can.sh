#!/usr/bin/env bash
# CANable2 (slcan firmware) helper for can-utils.
#
#   ./can.sh up [rate] [--tx]   bring can0 up (default 250k, listen-only)
#   ./can.sh down               take can0 down and stop slcand
#   ./can.sh scan [seconds]     try every bitrate (listen-only), report which one sees frames
#   ./can.sh status             show can0 state and counters
#
# rate: 10k 20k 50k 100k 125k 250k 500k 800k 1M
# Env overrides: CAN_DEV (serial port), CAN_IF (interface name, default can0)

set -euo pipefail

CAN_IF="${CAN_IF:-can0}"
CAN_DEV="${CAN_DEV:-$(ls /dev/serial/by-id/*CANable* 2>/dev/null | head -n1 || true)}"
CAN_DEV="$(readlink -f "${CAN_DEV:-/dev/ttyACM0}")"  # resolve by-id link so pkill matches any slcand on this tty

# Most common rates first so a scan finds the answer quickly.
SCAN_ORDER=(250k 500k 125k 1M 100k 50k 20k 10k 800k)

rate_code() {
  case "$1" in
    10k) echo 0 ;; 20k) echo 1 ;; 50k) echo 2 ;; 100k) echo 3 ;; 125k) echo 4 ;;
    250k) echo 5 ;; 500k) echo 6 ;; 800k) echo 7 ;; 1M|1000k) echo 8 ;;
    *) echo "unknown rate '$1' (use: ${SCAN_ORDER[*]})" >&2; exit 2 ;;
  esac
}

need_root() {
  if [[ $EUID -ne 0 ]]; then exec sudo -E "$0" "$@"; fi
}

if_down() {
  ip link set "$CAN_IF" down 2>/dev/null || true
  pkill -f "slcand .*${CAN_DEV##*/}" 2>/dev/null || true
  # wait for the netdev to disappear so the next slcand can reuse the name
  for _ in $(seq 20); do
    ip link show "$CAN_IF" &>/dev/null || return 0
    sleep 0.1
  done
}

# if_up <rate> <listen_only:1|0>
if_up() {
  local code mode
  code=$(rate_code "$1")
  mode=-l
  [[ "$2" == 0 ]] && mode=-o
  [[ -e "$CAN_DEV" ]] || { echo "adapter not found at $CAN_DEV" >&2; exit 1; }
  modprobe can; modprobe can_raw; modprobe slcan
  if_down
  slcand -o -c "$mode" -s"$code" "$CAN_DEV" "$CAN_IF"
  for _ in $(seq 30); do
    ip link show "$CAN_IF" &>/dev/null && break
    sleep 0.1
  done
  ip link set "$CAN_IF" up txqueuelen 1000
}

stat() { cat "/sys/class/net/$CAN_IF/statistics/$1" 2>/dev/null || echo 0; }

cmd_up() {
  local rate="${1:-250k}" listen=1
  [[ "${2:-}" == "--tx" || "${1:-}" == "--tx" ]] && listen=0
  [[ "$rate" == "--tx" ]] && rate=250k
  if_up "$rate" "$listen"
  echo "$CAN_IF up at $rate ($([[ $listen == 1 ]] && echo listen-only || echo normal/TX)) on $CAN_DEV"
  echo "read with: candump -tA -c $CAN_IF"
}

cmd_down() {
  if_down
  echo "$CAN_IF down"
}

cmd_status() {
  ip -details -statistics link show "$CAN_IF" 2>/dev/null || echo "$CAN_IF not present"
}

cmd_scan() {
  local dwell="${1:-3}" rate frames errs best="" best_n=0
  echo "Scanning $CAN_DEV listen-only, ${dwell}s per rate (bus is never driven)"
  printf '%-6s %8s %8s\n' rate frames rx_err
  for rate in "${SCAN_ORDER[@]}"; do
    if_up "$rate" 1
    local e0; e0=$(stat rx_errors)
    frames=$(timeout "$dwell" candump -L "$CAN_IF" 2>/dev/null | wc -l || true)
    errs=$(( $(stat rx_errors) - e0 ))
    printf '%-6s %8s %8s\n' "$rate" "$frames" "$errs"
    if (( frames > best_n )); then best="$rate"; best_n=$frames; fi
  done
  if_down
  echo
  if [[ -n "$best" ]]; then
    echo "=> bitrate looks like $best ($best_n frames). Wiring/polarity is correct."
    echo "   start it with: $0 up $best"
  else
    cat <<EOF
=> no frames at any rate. Check, in this order:
   1. Is the bus active? (engine/ECU on, ignition key on)
   2. Swap CANH and CANL at the adapter, then run '$0 scan' again.
      Swapping is harmless in listen-only mode.
   3. Common GND between adapter and machine.
   4. Termination: measure CANH-CANL with power off, should be ~60 ohm.
      ~120 ohm = one terminator missing -> enable the CANable termination.
   5. Try a longer dwell for slow/rare traffic: $0 scan 10
EOF
  fi
}

usage() { sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'; }

case "${1:-}" in
  up)     need_root "$@"; shift; cmd_up "$@" ;;
  down)   need_root "$@"; cmd_down ;;
  scan)   need_root "$@"; shift; cmd_scan "$@" ;;
  status) cmd_status ;;
  *)      usage; exit 1 ;;
esac
