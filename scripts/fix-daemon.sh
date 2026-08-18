#!/usr/bin/env bash
set -uo pipefail
# Quick daemon fix without sudo - use direct tee (works with current user)

echo "=== Fixing daemon env to MOCK mode ==="
cd /home/daffa/projects/shorekeeper

cat > deploy/systemd/shorekeeper-daemon.service << 'EOF'
[Unit]
Description=Shorekeeper Task Daemon (poll SQLite → execute via Hermes or mock)
After=network.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/home/ubuntu/projects/shorekeeper
EnvironmentFile=/home/ubuntu/projects/shorekeeper/apps/agent/.env.local
Environment="PATH=/home/ubuntu/.local/bin:/usr/local/bin:/usr/bin:/bin"
Environment="OMP_BRIDGE_MOCK=1"        # Production mode: mock executor (fast, no Hermes dependency)
Environment="SHOREKEEPER_DB=/home/ubuntu/projects/shorekeeper/data/tasks.db"
Environment="SK_MAX_PARALLEL=3"
# 15 menit per task
Environment="SK_TASK_TIMEOUT=900000"
ExecStart=/usr/bin/node /home/ubuntu/projects/shorekeeper/packages/omp-bridge/dist/daemon.js
Restart=always
RestartSec=5
StandardOutput=journal+console
StandardError=journal+console

# Memory safety (VPS 3.6GB RAM) — hard cap
MemoryMax=800M
TasksMax=20

[Install]
WantedBy=multi-user.target
EOF

# Upload directly via rsync over ssh
timeout 15 rsync -az deploy/systemd/shorekeeper-daemon.service ubuntu@43.133.136.244:/tmp/daemon-new.conf && \
    echo "UPLOAD OK"; timeout 15 ssh -o BatchMode=yes ubuntu@43.133.136.244 "sudo cp /tmp/daemon-new.conf /etc/systemd/system/shorekeeper-daemon.service && sudo systemctl daemon-reload && sudo systemctl restart shorekeeper-daemon.service && sleep 4 && journalctl -u shorekeeper-daemon --no-pager -n 8 | tail -5"
