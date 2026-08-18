# Fix VPS service + deploy without sudo issues (assume NOPASSWD sudo)

#!/usr/bin/env bash
set -uo pipefail
cd /home/daffa/projects/shorekeeper

echo "=== Step 1: Upload agent source ===" && \
    timeout 15 rsync -az apps/agent/src/agent_gemini_live.py ubuntu@43.133.136.244:/home/ubuntu/projects/shorekeeper/apps/agent/src/ && \
    echo "Step 1 DONE"

echo "=== Step 2: Deploy systemd service + restart ===" && \
    ssh -o BatchMode=yes ubuntu@43.133.136.244 'sudo tee /etc/systemd/system/shorekeeper-agent.service > /dev/null' < deploy/systemd/shorekeeper-agent.service && \
    ssh -o BatchMode=yes ubuntu@43.133.136.244 'sudo systemctl daemon-reload && sudo systemctl restart shorekeeper-agent.service' && \
    echo "Step 2 DONE"

echo "=== Step 3: Verify restart success ===" && \
    sleep 8 && \
    ssh -o BatchMode=yes ubuntu@43.133.136.244 'journalctl -u shorekeeper-agent --no-pager -n 10 | grep -E "Shorekeeper Gemini|GeminiTTS|Participant joined" | tail -5'
