#!/usr/bin/env bash
# Tervyn VPN helper installer for macOS and Linux.
#   bash install.sh              install / update
#   bash install.sh --uninstall  remove everything
#   bash install.sh --id <extension-id>   allow a different extension id (e.g. a store build)
set -euo pipefail

HOST_NAME="com.opengate.vpn"
EXT_ID="aekgcagkmfabhjpmnhaaepiljnnhmcbp"
HOME_DIR="$HOME/.opengate-vpn"
HERE="$(cd "$(dirname "$0")" && pwd)"
UNINSTALL=0

while [ $# -gt 0 ]; do
  case "$1" in
    --uninstall) UNINSTALL=1 ;;
    --id) EXT_ID="$2"; shift ;;
    *) echo "Unknown option $1"; exit 1 ;;
  esac
  shift
done

OS="$(uname -s)"
if [ "$OS" = "Darwin" ]; then
  BASE="$HOME/Library/Application Support"
  BROWSER_DIRS=("Google/Chrome" "Google/Chrome Beta" "Chromium" "BraveSoftware/Brave-Browser" "Microsoft Edge" "Vivaldi" "Arc/User Data" "Yandex/YandexBrowser")
else
  BASE="$HOME/.config"
  BROWSER_DIRS=("google-chrome" "google-chrome-beta" "chromium" "BraveSoftware/Brave-Browser" "microsoft-edge" "vivaldi" "yandex-browser")
fi

if [ "$UNINSTALL" = 1 ]; then
  [ -f "$HOME_DIR/xray.pid" ] && kill "$(cat "$HOME_DIR/xray.pid")" 2>/dev/null || true
  for d in "${BROWSER_DIRS[@]}"; do rm -f "$BASE/$d/NativeMessagingHosts/$HOST_NAME.json"; done
  rm -rf "$HOME_DIR"
  echo "Tervyn helper removed."
  exit 0
fi

PY="$(command -v python3 || true)"
if [ -z "$PY" ]; then
  echo "Python 3 is required. Install it first (macOS: 'xcode-select --install' or brew install python; Linux: your package manager)."
  exit 1
fi

ARCH="$(uname -m)"
case "$OS-$ARCH" in
  Darwin-arm64) ASSET="Xray-macos-arm64-v8a.zip" ;;
  Darwin-x86_64) ASSET="Xray-macos-64.zip" ;;
  Linux-x86_64) ASSET="Xray-linux-64.zip" ;;
  Linux-aarch64|Linux-arm64) ASSET="Xray-linux-arm64-v8a.zip" ;;
  Linux-armv7l) ASSET="Xray-linux-arm32-v7a.zip" ;;
  Linux-i686|Linux-i386) ASSET="Xray-linux-32.zip" ;;
  *) echo "Unsupported system: $OS $ARCH"; exit 1 ;;
esac

mkdir -p "$HOME_DIR/xray"
echo "Downloading Xray-core ($ASSET)…"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
curl -fL --retry 3 -o "$TMP/xray.zip" "https://github.com/XTLS/Xray-core/releases/latest/download/$ASSET"
"$PY" -m zipfile -e "$TMP/xray.zip" "$TMP/xray"
[ -f "$HOME_DIR/xray.pid" ] && kill "$(cat "$HOME_DIR/xray.pid")" 2>/dev/null || true
cp -f "$TMP/xray/xray" "$HOME_DIR/xray/xray"
cp -f "$TMP/xray/"*.dat "$HOME_DIR/xray/" 2>/dev/null || true
chmod +x "$HOME_DIR/xray/xray"
[ "$OS" = "Darwin" ] && xattr -d com.apple.quarantine "$HOME_DIR/xray/xray" 2>/dev/null || true

cp -f "$HERE/opengate_host.py" "$HOME_DIR/opengate_host.py"
cat > "$HOME_DIR/opengate_host.sh" <<EOF
#!/bin/sh
exec "$PY" "$HOME_DIR/opengate_host.py" "\$@"
EOF
chmod +x "$HOME_DIR/opengate_host.sh"

MANIFEST=$(cat <<EOF
{
  "name": "$HOST_NAME",
  "description": "Tervyn VPN helper",
  "path": "$HOME_DIR/opengate_host.sh",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$EXT_ID/"]
}
EOF
)

INSTALLED=0
for d in "${BROWSER_DIRS[@]}"; do
  if [ -d "$BASE/$d" ]; then
    mkdir -p "$BASE/$d/NativeMessagingHosts"
    echo "$MANIFEST" > "$BASE/$d/NativeMessagingHosts/$HOST_NAME.json"
    echo "  ✓ registered for $d"
    INSTALLED=1
  fi
done
if [ "$INSTALLED" = 0 ]; then
  echo "No Chromium-based browser profile found. Open Chrome once, then run this again."
  exit 1
fi

echo
"$HOME_DIR/xray/xray" version | head -n1
echo "Done! Open the Tervyn extension → Settings → Recheck."
