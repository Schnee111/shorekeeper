#!/usr/bin/env bash
# Install omp release binary global (idempotent).
set -euo pipefail

SRC="${1:-/tmp/omp-linux-x64}"
DEST_DIR="$HOME/.hermes/node/lib/node_modules/oh-my-pi"
BIN_LINK="$HOME/.hermes/node/bin/omp"

mkdir -p "$DEST_DIR" "$(dirname "$BIN_LINK")"
cp "$SRC" "$DEST_DIR/omp-linux-x64"
chmod +x "$DEST_DIR/omp-linux-x64"
ln -sf "$DEST_DIR/omp-linux-x64" "$BIN_LINK"
echo "Installed: $BIN_LINK -> $DEST_DIR/omp-linux-x64"
