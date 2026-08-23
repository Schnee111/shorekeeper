#!/usr/bin/env bash
set -uo pipefail
# Fix nginx config via sudo over SSH

NGINX_CONF=$(cat << 'EOF'
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
EOF
)

echo "=== Deploying Shorekeeper Nginx Config ==="
echo "${NGINX_CONF}" | timeout 15 ssh -o BatchMode=yes ubuntu@43.133.136.244 "sudo tee /etc/nginx/sites-enabled/tethys >/dev/null && sudo nginx -t && echo 'NGINX_TEST_OK'" 2>&1 | tail -3

echo "=== Reloading nginx ==="
timeout 15 ssh -o BatchMode=yes ubuntu@43.133.136.244 "sudo systemctl reload nginx && sleep 2 && curl -sI http://localhost:80/shorekeeper/ | head -3" 2>&1
