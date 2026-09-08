#!/bin/bash
# pi-memory-master setup — local glue for remote QMD + Phoenix (Modal).
#
# Installs:
#   /usr/local/bin/qmd-server   session lifecycle wrapper (start/stop/status)
#   <PATH>/qmd                  remote shim — translates qmd CLI -> Modal HTTP
#                               (keeps pi-memory's memory_search working with
#                                zero local llama.cpp / zero background CPU)
#   /usr/local/etc/*.conf       config with Modal URLs + Proxy Token
#
# NO Modal deployment here — the server is assumed to be already running
# (see infra.py in the qmd-modal project for the server side).
#
# Usage:
#   ./setup.sh                              # conf templates only, tokens filled manually
#   ./setup.sh --key wk-xxx --secret ws-yyy # fill token non-interactively
#
# Get a Proxy Token: modal.com dashboard → Settings → Proxy Tokens.
set -euo pipefail

PREFIX="${PREFIX:-/usr/local}"
ETC="$PREFIX/etc"
KEY="" SECRET=""

while [ $# -gt 0 ]; do
  case "$1" in
    --key)    KEY="$2"; shift 2;;
    --secret) SECRET="$2"; shift 2;;
    *) echo "unknown flag: $1" >&2; exit 2;;
  esac
done

mkdir -p "$PREFIX/bin" "$ETC"

# --- 1) qmd-server wrapper -------------------------------------------------
install -m 755 "$(dirname "$0")/bin/qmd-server" "$PREFIX/bin/qmd-server"
echo "✓ $PREFIX/bin/qmd-server"

# --- 2) qmd shim ------------------------------------------------------------
TARGET_QMD="$PREFIX/bin/qmd"
if command -v qmd >/dev/null 2>&1 && [ ! -f "$TARGET_QMD" ]; then
  EXISTING="$(command -v qmd)"
  if grep -q "qmd-shim" "$EXISTING" 2>/dev/null; then
    TARGET_QMD="$EXISTING"           # existing shim elsewhere in PATH
  else
    echo "⚠ real qmd found at $EXISTING — NOT overwriting; installing shim as $TARGET_QMD"
    echo "  (if both are in PATH, adjust PATH order so the shim wins)"
  fi
fi
install -m 755 "$(dirname "$0")/bin/qmd-shim" "$TARGET_QMD"
echo "✓ $TARGET_QMD"

# --- 3) configs (never overwrite) ------------------------------------------
write_conf() { # path content
  if [ -f "$1" ]; then
    echo "• $1 exists — left untouched"
  else
    printf '%s' "$2" > "$1"; chmod 600 "$1"
    echo "✓ $1"
  fi
}

QMD_URL_DEFAULT="${QMD_REMOTE_URL:-https://ttdudd7d--qmd-mcp.modal.run}"
PHX_URL_DEFAULT="${PI_PHOENIX_URL:-https://ttdudd7d--phoenix.modal.run}"
if [ -n "$KEY" ] && [ -n "$SECRET" ]; then TOKEN="$KEY.$SECRET"; else TOKEN="wk-TOKEN_ID.ws-TOKEN_SECRET"; fi

write_conf "$ETC/qmd-server.conf" \
"# Remote QMD on Modal (CPU) — Modal Proxy Token auth
QMD_REMOTE_URL=$QMD_URL_DEFAULT
MODAL_KEY=${KEY:-wk-TOKEN_ID}
MODAL_SECRET=${SECRET:-ws-TOKEN_SECRET}
"

write_conf "$ETC/pi-phoenix.conf" \
"# Arize Phoenix on Modal — OTLP target for pi tracing
PI_PHOENIX_URL=$PHX_URL_DEFAULT
PI_PHOENIX_TOKEN=$TOKEN
"

# --- 4) qmd-modal project -------------------------------------------------
# Copies the qmd-modal deployment project into PREFIX/share/qmd-modal
# so infra.py, trace/, and test_trace.py are available for maintenance.
QMD_MODAL_DIR="$PREFIX/share/qmd-modal"
mkdir -p "$QMD_MODAL_DIR"
cp -r "$(dirname "$0")/qmd-modal"/* "$QMD_MODAL_DIR/"
chmod +x "$QMD_MODAL_DIR/sync_data.sh" "$QMD_MODAL_DIR/sync_memory.sh" 2>/dev/null || true
echo "✓ $QMD_MODAL_DIR"

echo
echo "Done. If you passed no --key/--secret, edit token placeholders in:"
echo "  $ETC/qmd-server.conf , $ETC/pi-phoenix.conf"
echo "Then restart pi — extensions load automatically."
