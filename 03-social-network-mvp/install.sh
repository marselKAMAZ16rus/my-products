#!/usr/bin/env bash
set -euo pipefail
if [ "$(id -u)" != 0 ]; then echo 'Запустите установщик от root.'; exit 1; fi
cd /opt/reef
apt-get update
apt-get install -y curl ca-certificates xz-utils nginx python3 certbot python3-certbot-nginx sqlite3
if ! /usr/local/bin/node -e 'process.exit(Number(process.versions.node.split(".")[0])>=24?0:1)' 2>/dev/null; then
 case "$(uname -m)" in x86_64) reef_arch=x64 ;; aarch64) reef_arch=arm64 ;; *) echo 'Неподдерживаемая архитектура'; exit 1 ;; esac
 reef_tmp=$(mktemp -d)
 curl -fsS --proto '=https' https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt -o "$reef_tmp/SHASUMS256.txt"
 reef_tar=$(awk -v arch="$reef_arch" '$2 ~ ("^node-v24\\.[0-9]+\\.[0-9]+-linux-" arch "\\.tar\\.xz$") { print $2; exit }' "$reef_tmp/SHASUMS256.txt")
 if [ -z "$reef_tar" ]; then echo 'Не удалось определить пакет Node.js'; exit 1; fi
 curl -fS --proto '=https' "https://nodejs.org/dist/latest-v24.x/$reef_tar" -o "$reef_tmp/$reef_tar"
 (cd "$reef_tmp"; awk -v name="$reef_tar" '$2==name' SHASUMS256.txt | sha256sum -c -)
 tar -xJf "$reef_tmp/$reef_tar" -C /opt
 reef_node_dir="/opt/${reef_tar%.tar.xz}"
 for reef_bin in node npm npx; do ln -sfn "$reef_node_dir/bin/$reef_bin" "/usr/local/bin/$reef_bin"; done
 rm -rf "$reef_tmp"
fi
export PATH="/usr/local/bin:$PATH"
/usr/local/bin/npm ci --omit=dev --ignore-scripts --no-audit --no-fund
chmod -R a+rX /opt/reef
python3 /opt/reef/configure.py
/usr/local/bin/node /opt/reef/setup-keys.mjs
/usr/local/bin/node /opt/reef/smtp-check.mjs
id reef >/dev/null 2>&1 || useradd --system --home /var/lib/reef --shell /usr/sbin/nologin reef
install -d -m 700 -o reef -g reef /var/lib/reef /var/lib/reef/media
reef_domain=$(/usr/local/bin/node -p 'new URL(JSON.parse(require("node:fs").readFileSync("/etc/reef/reef.json","utf8")).REEF_ORIGIN).hostname')
reef_owner=$(/usr/local/bin/node -p 'JSON.parse(require("node:fs").readFileSync("/etc/reef/reef.json","utf8")).REEF_OWNER_EMAIL')
cat > /etc/nginx/sites-available/reef <<EOF
server {
 listen 80;
 server_name $reef_domain;
 client_max_body_size 10m;
 location / {
  proxy_pass http://127.0.0.1:3300;
  proxy_http_version 1.1;
  proxy_set_header Host \$host;
  proxy_set_header X-Real-IP \$remote_addr;
  proxy_set_header X-Forwarded-Proto \$scheme;
  proxy_read_timeout 60s;
 }
}
EOF
ln -sfn /etc/nginx/sites-available/reef /etc/nginx/sites-enabled/reef
nginx -t
systemctl enable --now nginx
systemctl reload nginx
certbot --nginx --non-interactive --agree-tos --email "$reef_owner" -d "$reef_domain" --redirect
install -m 644 /opt/reef/reef.service /etc/systemd/system/reef.service
systemctl daemon-reload
systemctl enable --now reef
sleep 2
systemctl is-active --quiet reef
curl --fail --silent --show-error "https://$reef_domain/reef-api/me"
printf '\nReef запущен: https://%s\nВойдите по почте владельца: %s\n' "$reef_domain" "$reef_owner"
echo 'Первый подтверждённый вход создаст аккаунт владельца. Старые аккаунты и посты не перенесены.'
