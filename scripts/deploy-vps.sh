#!/usr/bin/env bash
set -uo pipefail
# scripts/deploy-vps.sh — Deploy Shorekeeper ke VPS (ubuntu@43.133.136.244)
# Route baru: /shorekeeper/ (tanpa bentrok dengan jarvis yang ada di /jarvis/)

SRC=/home/daffa/projects/shorekeeper
VHOST=ubuntu@43.133.136.244

echo "=== SHOREKEEPER DEPLOY TO VPS ==="
echo "Source: ${SRC}"
echo "Target VPS: ${VHOST}"
echo "Route: /shorekeeper/"

cd "${SRC}"

# 1. Build client dist
echo "--- Building client dist ---"
pnpm --filter shorekeeper-client build || exit 1

# 2. Sync dist to VPS (/var/www/shorekeeper/)
echo "--- Rsync client dist to /var/www/shorekeeper/ ---"
rsync -avz apps/client/dist/ "${VHOST}:${SRC}/apps/client/dist/"
rsync -avz "${SRC}/apps/client/dist/" ubuntu@43.133.136.244:/var/www/shorekeeper/

# 3. Rsync repo untuk daemon + agent (sudah include deps via systemd env)
echo "--- Rsync packages/omp-bridge for daemon ---"
rsync -avz packages/omp-bridge/ "${VHOST}:${SRC}/packages/omp-bridge/"

# 4. Install npm deps on VPS dan restart daemon (mock mode default)
echo "--- Installing OMP dependencies on VPS ---"
ssh "${VHOST}" "cd ${SRC} && pnpm install --prefix packages/omp-bridge --prod"

# 5. Restart daemon service jika sudah terinstall
echo "--- Checking/Restarting daemon service ---"
ssh "${VHOST}" <<'EOF'
if systemctl list-units --type=service --state=running | grep -q shorekeeper-daemon; then
  sudo systemctl restart shorekeeper-daemon
else
  echo "Daemon belum ter-install, skip restart"
fi
EOF

echo "=== DEPLOY COMPLETE ==="
echo "Frontend: http://tethys.web.id/shorekeeper/"
echo "Agent worker: auto-dispatch via token server :8082"
echo "Check logs: journalctl -u shorekeeper-daemon -f"
