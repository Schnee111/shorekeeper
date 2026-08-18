#!/usr/bin/env bash
set -uo pipefail
# Manual VPS deployment (unmask services)

echo "=== MANUAL VPS DEPLOYMENT ==="
cd /home/daffa/projects/shorekeeper

# 1. Unmask all shorekeeper services on VPS
echo "--- Unmasking services ---"
timeout 15 ssh -o BatchMode=yes ubuntu@43.133.136.244 << 'VSSH'
sudo systemctl mask --no-reload shorekeeper-daemon.service 2>/dev/null || true
sudo systemctl unmask shorekeeper-daemon.service 2>/dev/null || true
sudo systemctl unmask shorekeeper-token-server.service 2>/dev/null || true
sudo systemctl unmask shorekeeper-agent.service 2>/dev/null || true
echo "Unmasked done"
VSSH

# 2. Install dependencies on VPS  
echo "--- Installing Python deps ---"
timeout 15 ssh -o BatchMode=yes ubuntu@43.133.136.244 << 'VSSH'
cd /home/ubuntu/projects/shorekeeper/apps/token-server
python3 -m pip install aiohttp python-dotenv livekit-api --quiet --user 2>/dev/null || true
echo "Python deps installed"
VSSH

# 3. Start services one by one
echo "--- Starting services ---"
timeout 15 ssh -o BatchMode=yes ubuntu@43.133.136.244 << 'VSSH'
systemctl daemon-reload
systemctl start shorekeeper-token-server.service && echo "Token Server: started"
sleep 2
systemctl start shorekeeper-daemon.service && echo "Daemon: started"
sleep 2
systemctl start shorekeeper-agent.service && echo "Agent: started"
systemctl status shorekeeper-* --no-pager | grep -E "Active|Loaded|Process:" | head -9
VSSH

# 4. Verify frontend + backend
echo ""
echo "=== VERIFICATION ==="
echo "Frontend:"
curl -sI "https://tethys.web.id/shorekeeper/" | head -3
echo ""
echo "Token API:"
timeout 10 curl -s "https://tethys.web.id/shorekeeper/api/token?room=test&identity=schnee" 2>&1 | python3 -c "import json,sys; d=json.load(sys.stdin); print('Token:', len(d.get('token','')), 'chars'); print('Voice:', d.get('voice_id'))" 2>&1 || echo "Token error"
echo ""
echo "Voices API:"
timeout 10 curl -s "https://tethys.web.id/shorekeeper/api/voices" | python3 -c "import json,sys; d=json.load(sys.stdin); v=[x['id'] for x in d.get('voices',[])]; print(f'{len(v)} voices: {v[:5]}')" 2>&1 || echo "Voices error"
echo ""
echo "Systemd Status:"
timeout 15 ssh -o BatchMode=yes ubuntu@43.133.136.244 "journalctl -u shorekeeper-* --no-pager -n 5 --no-hostname 2>&1 | tail -8" 2>&1

echo ""
echo "=== DEPLOY COMPLETE ==="
echo "Access at: https://tethys.web.id/shorekeeper/"
echo "Old jarvis still at: https://tethys.web.id/jarvis-livekit/"
echo "Check logs: journalctl -u shorekeeper-* -f"
