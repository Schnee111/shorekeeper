#!/usr/bin/env bash
set -uo pipefail
# Quick service install to /etc/systemd/system/

echo "=== INSTAL SERVICES TO SYSTEMD ==="

cd /home/daffa/projects/shorekeeper/deploy/systemd

for svc in *.service; do
    echo "--- Installing $svc ---"
    sudo cat "$svc" | timeout 15 ssh -o BatchMode=yes ubuntu@43.133.136.244 "sudo tee /etc/systemd/system/${svc} >/dev/null && echo 'COPIED: ${svc}'" 2>&1 | tail -1
done

echo "--- Reloading systemd ---"
timeout 15 ssh -o BatchMode=yes ubuntu@43.133.136.244 "sudo systemctl daemon-reload"

echo "--- Starting all services ---"
timeout 15 ssh -o BatchMode=yes ubuntu@43.133.136.244 << 'VSSH'
systemctl start shorekeeper-token-server.service 2>&1 || echo "Token Server FAIL"
sleep 2
systemctl start shorekeeper-daemon.service 2>&1 || echo "Daemon FAIL"
sleep 2
systemctl start shorekeeper-agent.service 2>&1 || echo "Agent FAIL"

echo ""
echo "STATUS:"
systemctl status shorekeeper-* --no-pager | grep -E "^ Shorekeeper|^Active|Loaded.*\((enabled|disabled)\)" | head -12
VSSH

echo "--- VERIFYING PORTS ---"
timeout 15 ssh -o BatchMode=yes ubuntu@43.133.136.244 "ss -tlnp | grep -E ':808[0-3]'"
