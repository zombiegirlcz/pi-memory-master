#!/bin/bash
# pi-memory setup — local glue for remote QMD + Phoenix (Modal).
#
# Installs:
#   <PREFIX>/bin/qmd-server       session lifecycle wrapper (start/stop/status)
#   <PATH>/qmd                    remote shim — translates qmd CLI -> Modal HTTP
#                                 (keeps pi-memory's memory_search working with
#                                  zero local llama.cpp / zero background CPU)
#   <PREFIX>/bin/qmd-modal-mcp    stdio MCP server for pi-mcp (deploy + all
#                                 infra.py functions); auto-registered via
#                                 package.json "pi.mcp" -> mcp/qmd-modal.mcp.json
#   ~/.local/etc/pi-memory.conf   UNIFIED config: QMD URL + Modal tokens
#                                 (same file read by extensions/pi-phoenix.ts)
#
# NO Modal deployment here — the server is assumed to be already running
# (see infra.py in the qmd-modal project for the server side).
#
# Usage:
#   ./setup.sh                               # conf template, tokens filled manually
#   ./setup.sh --key wk-xxx --secret ws-yyy  # one Modal proxy token (QMD + Phoenix)
#   ./setup.sh --phoenix-token wk-x.ws-y     # separate Phoenix token (optional)
#
# Env overrides: PREFIX (bin dir, default /usr/local), PI_MEMORY_CONF_DIR
# (conf dir, default ~/.local/etc), PI_MEMORY_CONF (exact conf file path).
#
# Get Proxy Tokens: modal.com dashboard → Settings → Proxy Tokens.
set -euo pipefail

PREFIX_BIN="${PREFIX:-/usr/local}"
CONF_DIR="${PI_MEMORY_CONF_DIR:-$HOME/.local/etc}"
CONF="${PI_MEMORY_CONF:-$CONF_DIR/pi-memory.conf}"
KEY="" SECRET="" PHX_TOKEN=""

while [ $# -gt 0 ]; do
  case "$1" in
    --key)           KEY="$2"; shift 2;;
    --secret)        SECRET="$2"; shift 2;;
    --phoenix-token) PHX_TOKEN="$2"; shift 2;;
    *) echo "unknown flag: $1" >&2; exit 2;;
  esac
done

mkdir -p "$PREFIX_BIN/bin" "$CONF_DIR"

# --- 1) qmd-server wrapper -------------------------------------------------
install -m 755 "$(dirname "$0")/bin/qmd-server" "$PREFIX_BIN/bin/qmd-server"
echo "✓ $PREFIX_BIN/bin/qmd-server"

# --- 2) qmd shim ------------------------------------------------------------
TARGET_QMD="$PREFIX_BIN/bin/qmd"
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

# --- 2b) qmd-modal MCP server (pi-mcp) --------------------------------------
install -m 755 "$(dirname "$0")/mcp/qmd-modal-server.mjs" "$PREFIX_BIN/bin/qmd-modal-mcp"
echo "✓ $PREFIX_BIN/bin/qmd-modal-mcp (pi-mcp: deploy + all infra.py functions)"

# --- 3) unified config (never overwrite) ------------------------------------
# Reads a KEY=VALUE from the first legacy file that defines it, so an install
# created before the unification migrates without re-typing tokens.
legacy_get() { # key file...
  local key="$1"; shift
  local f val
  for f in "$@"; do
    [ -f "$f" ] || continue
    val="$(sed -n "s/^[[:space:]]*${key}[[:space:]]*=[[:space:]]*//p" "$f" | tail -n1)"
    if [ -n "$val" ]; then printf '%s' "$val"; return 0; fi
  done
  return 1
}

LEGACY_QMD=("$CONF_DIR/qmd-server.conf" "/usr/local/etc/qmd-server.conf")
LEGACY_PHX=("$CONF_DIR/pi-phoenix.conf" "/usr/local/etc/pi-phoenix.conf")

if [ -f "$CONF" ]; then
  echo "• $CONF exists — left untouched"
else
  [ -n "$KEY" ]       || KEY="$(legacy_get MODAL_KEY "${LEGACY_QMD[@]}" || true)"
  [ -n "$SECRET" ]    || SECRET="$(legacy_get MODAL_SECRET "${LEGACY_QMD[@]}" || true)"
  [ -n "$PHX_TOKEN" ] || PHX_TOKEN="$(legacy_get PI_PHOENIX_TOKEN "${LEGACY_PHX[@]}" || true)"
  QMD_URL="${QMD_REMOTE_URL:-$(legacy_get QMD_REMOTE_URL "${LEGACY_QMD[@]}" || true)}"
  PHX_URL="${PI_PHOENIX_URL:-$(legacy_get PI_PHOENIX_URL "${LEGACY_PHX[@]}" || true)}"
  QMD_URL="${QMD_URL:-https://ttdudd7d--qmd-mcp.modal.run}"
  PHX_URL="${PHX_URL:-https://ttdudd7d--phoenix.modal.run}"
  KEY="${KEY:-wk-TOKEN_ID}"
  SECRET="${SECRET:-ws-TOKEN_SECRET}"
  PHX_TOKEN="${PHX_TOKEN:-${KEY}.${SECRET}}"

  umask 077
  cat > "$CONF" <<EOF
# pi-memory — UNIFIED config: remote QMD search + Arize Phoenix tracing (Modal).
# Read by: bin/qmd-server, bin/qmd-shim, extensions/pi-phoenix.ts
# Location: ~/.local/etc/pi-memory.conf  (override with PI_MEMORY_CONF=/path)
# chmod 600 — contains Modal proxy tokens.

# --- QMD search (Modal app "ai-services" / label qmd-mcp) ---
QMD_REMOTE_URL=$QMD_URL
MODAL_KEY=$KEY
MODAL_SECRET=$SECRET

# --- Arize Phoenix (OTLP tracing) ---
PI_PHOENIX_URL=$PHX_URL
PI_PHOENIX_TOKEN=$PHX_TOKEN
EOF
  chmod 600 "$CONF"
  echo "✓ $CONF"
fi

# --- 4) qmd-modal project -------------------------------------------------
# Copies the qmd-modal deployment project into PREFIX/share/qmd-modal
# so infra.py, trace/, and test_trace.py are available for maintenance.
QMD_MODAL_DIR="$PREFIX_BIN/share/qmd-modal"
mkdir -p "$QMD_MODAL_DIR"
cp -r "$(dirname "$0")/qmd-modal"/* "$QMD_MODAL_DIR/"
chmod +x "$QMD_MODAL_DIR/sync_data.sh" "$QMD_MODAL_DIR/sync_memory.sh" 2>/dev/null || true
echo "✓ $QMD_MODAL_DIR"

echo
echo "Done. If you passed no tokens, edit placeholders in:"
echo "  $CONF"
echo "Then restart pi — extensions load automatically."
