#!/usr/bin/env bash
# scripts/patch-plugin.sh — Apply livekit-gemini 1007 mitigation patch (idempotent).
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
PATCH_FILE="$ROOT_DIR/../deploy/patches/livekit-gemini-1007-fixed.patch"
VENV_PYTHON="${ROOT_DIR}/../apps/agent/.venv/lib/python3.11/site-packages/livekit/plugins/google/realtime/realtime_api.py"

if [[ ! -f "$PATCH_FILE" ]]; then
    echo "✗ Patch file not found: $PATCH_FILE"
    exit 1
fi

# Backup existing if different from original
if python3 -c "import hashlib, sys; \
    h=hashlib.sha256(open(sys.argv[1], 'rb').read()).hexdigest(); \
    print(h); \
    sys.exit(0 if h == 'd41d8cd98f00b204e9800998ecf8427e' else 1)" "$VENV_PYTHON" 2>/dev/null; then
    cp "$VENV_PYTHON" "${VENV_PYTHON}.bak"
fi

echo "Applying patch: $PATCH_FILE -> $VENV_PYTHON"
if ! patch --dry-run -p0 < "$PATCH_FILE"; then
    echo "Patch already applied or incompatible"
else
    patch -p0 < "$PATCH_FILE"
    echo "✓ Patch applied"
fi
