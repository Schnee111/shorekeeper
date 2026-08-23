#!/usr/bin/env bash
set -uo pipefail
# Final deployment script for Shorekeeper on VPS

echo "=== SHOREKEEPER FINAL DEPLOYMENT ==="

cd /home/daffa/projects/shorekeeper

# 1. Build + sync everything
echo "--- Building client & daemon ---"
pnpm --filter shorekeeper-client build || exit 1
rsync -az apps/client/dist/ ubuntu@43.133.136.244:/var/www/shorekeeper/
rsync -az packages/omp-bridge/ ubuntu@43.133.136.244:/home/ubuntu/projects/shorekeeper/packages/omp-bridge/

# 2. Install deps on VPS
echo "--- Installing VPS deps ---"
timeout 30 ssh -o BatchMode=yes ubuntu@43.133.136.244 <<'VSSH'
cd /home/ubuntu/projects/shorekeeper/apps/token-server
~/.local/bin/uv sync --project . --quiet
pip install aiohttp python-dotenv livekit-api --quiet --user 2>/dev/null || true
VSSH

# 3. Copy config + services to VPS via tee
echo "--- Deploying nginx config ---"
cat << 'NGINXCONF' | timeout 15 ssh -o BatchMode=yes ubuntu@43.133.136.244 "sudo tee /etc/nginx/sites-enabled/tethys >/dev/null"
server {
    listen 80;
    listen [::]:80;
    server_name tethys.web.id;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name tethys.web.id;

    ssl_certificate /etc/letsencrypt/live/tethys.web.id/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/tethys.web.id/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;

    include snippets/block-scanners.conf;

    location /shorekeeper/api/ {
        proxy_pass http://127.0.0.1:8083/;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }

    location /shorekeeper/ {
        alias /var/www/shorekeeper/;
        index index.html;
        try_files $uri $uri/ /shorekeeper/index.html;
    }

    location ~* \.(mjs|js)$ {
        root /var/www;
        types { application/javascript mjs js; }
        default_type application/javascript;
        add_header Content-Type application/javascript always;
    }

    location ~* \.css$ {
        root /var/www;
        types { text/css css; }
        default_type text/css;
        add_header Content-Type text/css always;
    }

    location ~* \.html$ {
        root /var/www;
        types { text/html html htm; }
        default_type text/html;
        add_header Content-Type text/html always;
    }

    location /jarvis-livekit/dispatch {
        proxy_pass http://127.0.0.1:8082/dispatch;
        proxy_set_header Host $host;
    }

    location /jarvis-livekit/token {
        proxy_pass http://127.0.0.1:8082/token;
        proxy_set_header Host $host;
    }

    location /jarvis-livekit/voices {
        proxy_pass http://127.0.0.1:8082/voices;
        add_header Cache-Control "no-store" always;
        proxy_set_header Host $host;
    }

    location /jarvis-livekit/ {
        alias /var/www/jarvis-livekit/;
        index index.html;
        try_files $uri $uri/ /jarvis-livekit/index.html;
    }

    location /api/ {
        proxy_pass http://127.0.0.1:8000/api/;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location /ws/ {
        proxy_pass http://127.0.0.1:8000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
    }
}
NGINXCONF

echo "--- Testing nginx config ---"
timeout 15 ssh -o BatchMode=yes ubuntu@43.133.136.244 "sudo nginx -t && echo 'NGINX OK'"

# 4. Install systemd services
echo "--- Installing systemd services ---"
for svc in deploy/systemd/*.service; do
    sudo cat "$svc" | timeout 15 ssh -o BatchMode=yes ubuntu@43.133.136.244 "sudo tee /etc/systemd/system/$(basename $svc) >/dev/null"
done

# Reload systemd + restart services
echo "--- Enabling services ---"
timeout 15 ssh -o BatchMode=yes ubuntu@43.133.136.244 << 'VSSH'
sudo systemctl daemon-reload
sudo systemctl enable shorekeeper-token-server.service shorekeeper-daemon.service shorekeeper-agent.service
sudo systemctl restart shorekeeper-token-server.service shorekeeper-daemon.service shorekeeper-agent.service 2>&1 || echo "Restart may fail (deps not ready), check logs: journalctl -u shorekeeper-*"
VSSH

# 5. Verify
echo "=== VERIFICATION ==="
timeout 15 curl -sI "https://tethys.web.id/shorekeeper/" | head -3
echo "---"
timeout 15 ssh -o BatchMode=yes ubuntu@43.133.136.244 "curl -s http://localhost:8083/token?room=test&identity=schnee 2>&1 | head -c 200"
echo "---"
timeout 15 ssh -o BatchMode=yes ubuntu@43.133.136.244 "systemctl status shorekeeper-* --no-pager | grep -E 'Active|Loaded' | head -9"

echo ""
echo "=== DEPLOY COMPLETE ==="
echo "Frontend: https://tethys.web.id/shorekeeper/"
echo "Agent Name: shorekeeper (separated from old jarvis)"
echo "Token Server: port 8083 (separated from jarvis:8082)"
echo "Check logs: journalctl -u shorekeeper-* -f"
