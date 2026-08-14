#!/bin/sh
# RFXmngr client bridge for the RFXCom2Matter TCP gateway.
#
# The bridge owns the USB stick and exposes it race-free on a TCP port
# (default 10001). socat here turns that TCP endpoint into a LOCAL virtual
# serial device (PTY) so RFXmngr can be pointed at a real COM/TTY port.
#
# Usage (run on the machine where RFXmngr runs, e.g. a Linux host/WSL):
#   ./scripts/rfxmngr-socat.sh [bridge-host] [bridge-port] [pty-path]
#
#   bridge-host : host running the bridge (default: 192.168.1.20)
#   bridge-port : TCP gateway port      (default: 10001)
#   pty-path    : local symlink to the  (default: /dev/rfxmngr)
#                 created PTY
#
# Then point RFXmngr at the serial device shown (e.g. /dev/rfxmngr or COM
# mapping under WSL). Only one RFXmngr client is intended at a time; all
# writes (bridge and RFXmngr) are serialized through a single queue, so
# Web UI / Matter control keeps working while the socat link is up.

set -e

HOST="${1:-192.168.1.20}"
PORT="${2:-10001}"
PTY="${3:-/dev/rfxmngr}"

echo "Bridging ${HOST}:${PORT} -> ${PTY} (ctrl-c to stop)"
exec socat -d -d PTY,link="${PTY}",raw,echo=0,group=dialout,mode=660 \
    "TCP:${HOST}:${PORT},forever,interval=5"
