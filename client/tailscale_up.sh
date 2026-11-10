#!/usr/bin/env bash
# Bring the Hark sandbox (or any Linux box without root/TUN) onto your tailnet in userspace mode.
#   export TS_AUTHKEY=tskey-auth-...   # from https://login.tailscale.com/admin/settings/keys (reusable + ephemeral recommended)
#   ./tailscale_up.sh
# Afterwards reach the laptop through the SOCKS5 proxy:
#   python3 hark_remote.py --host <laptop-tailscale-ip> --token-file token.txt --socks5 localhost:1055 status
set -euo pipefail

: "${TS_AUTHKEY:?Set TS_AUTHKEY to a Tailscale auth key (never commit it).}"
TS_HOSTNAME="${TS_HOSTNAME:-hark-sandbox}"
TS_DIR="${TS_DIR:-$HOME/.local/tailscale}"
SOCKS_PORT="${SOCKS_PORT:-1055}"
TS_VERSION="${TS_VERSION:-latest}"
SOCK="$TS_DIR/tailscaled.sock"
mkdir -p "$TS_DIR/state"

case "$(uname -m)" in
  x86_64|amd64) ARCH=amd64 ;;
  aarch64|arm64) ARCH=arm64 ;;
  armv7l|armv6l) ARCH=arm ;;
  i386|i686) ARCH=386 ;;
  *) echo "Unsupported architecture $(uname -m)"; exit 1 ;;
esac

if [ ! -x "$TS_DIR/tailscaled" ]; then
  if [ "$TS_VERSION" = "latest" ]; then
    TARBALL=$(curl -fsSL "https://pkgs.tailscale.com/stable/?mode=json" | python3 -c "import json,sys; print(json.load(sys.stdin)['Tarballs']['$ARCH'])")
  else
    TARBALL="tailscale_${TS_VERSION}_${ARCH}.tgz"
  fi
  echo "Downloading $TARBALL"
  curl -fsSL "https://pkgs.tailscale.com/stable/$TARBALL" -o "$TS_DIR/ts.tgz"
  tar -xzf "$TS_DIR/ts.tgz" -C "$TS_DIR" --strip-components=1
  rm -f "$TS_DIR/ts.tgz"
fi

if ! "$TS_DIR/tailscale" --socket="$SOCK" status >/dev/null 2>&1; then
  if ! pgrep -f "tailscaled.*$SOCK" >/dev/null 2>&1; then
    echo "Starting tailscaled (userspace networking, SOCKS5 on localhost:$SOCKS_PORT)"
    nohup "$TS_DIR/tailscaled" \
      --tun=userspace-networking \
      --socks5-server="localhost:$SOCKS_PORT" \
      --outbound-http-proxy-listen="localhost:$((SOCKS_PORT + 1))" \
      --state="$TS_DIR/state/tailscaled.state" \
      --statedir="$TS_DIR/state" \
      --socket="$SOCK" >"$TS_DIR/tailscaled.log" 2>&1 &
    for _ in $(seq 1 30); do [ -S "$SOCK" ] && break; sleep 0.5; done
  fi
  "$TS_DIR/tailscale" --socket="$SOCK" up --authkey="$TS_AUTHKEY" --hostname="$TS_HOSTNAME" --accept-dns=false
fi

"$TS_DIR/tailscale" --socket="$SOCK" status
echo
echo "Tailscale is up. SOCKS5 proxy: localhost:$SOCKS_PORT  (HTTP proxy: localhost:$((SOCKS_PORT + 1)))"
echo "This device's tailnet IP: $("$TS_DIR/tailscale" --socket="$SOCK" ip -4 2>/dev/null | head -1)"
