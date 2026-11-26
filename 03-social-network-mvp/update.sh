#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
if [ "$(id -u)" != 0 ]; then echo 'Запустите обновление от root.'; exit 1; fi
reef_archive=${1:-/root/reef-update.tar.gz}
if [ ! -f "$reef_archive" ] || [ ! -f /var/lib/reef/reef.sqlite ] || [ ! -f /etc/reef/reef.json ]; then echo 'Нужны архив обновления и уже установленный Reef.'; exit 1; fi
python3 - "$reef_archive" <<'PY'
import sys,tarfile
from pathlib import PurePosixPath
with tarfile.open(sys.argv[1]) as t:
 for item in t.getmembers():
  p=PurePosixPath(item.name)
  if p.is_absolute() or '..' in p.parts or not p.parts or p.parts[0]!='reef-server' or item.issym() or item.islnk() or not (item.isfile() or item.isdir()):raise SystemExit('Архив не прошёл проверку путей')
 for name in ['reef-server/app.mjs','reef-server/worker.js','reef-server/package-lock.json','reef-server/push.js']:
  t.getmember(name)
PY
reef_tag=$(date +%Y%m%d-%H%M%S)
reef_stage="/opt/reef-stage-$reef_tag"
reef_previous="/opt/reef-previous-$reef_tag"
reef_backup="/var/backups/reef/$reef_tag"
mkdir -p "$reef_stage" "$reef_backup"
tar -xzf "$reef_archive" -C "$reef_stage" --strip-components=1 --no-same-owner
chmod -R a+rX "$reef_stage"
export PATH="/usr/local/bin:$PATH"
(cd "$reef_stage"; npm ci --omit=dev --ignore-scripts --no-audit --no-fund)
chmod -R a+rX "$reef_stage"
node --check "$reef_stage/app.mjs"
node --check "$reef_stage/worker.js"
node --check "$reef_stage/auth.mjs"
reef_stopped=0
reef_swapped=0
rollback(){
 reef_status=$?
 trap - ERR
 if [ "$reef_stopped" = 1 ]; then
  systemctl stop reef || true
  if [ "$reef_swapped" = 1 ] && [ -d "$reef_previous" ]; then if [ -d /opt/reef ]; then mv /opt/reef "/opt/reef-failed-$reef_tag"; fi; mv "$reef_previous" /opt/reef; fi
  if [ -f "$reef_backup/reef.sqlite" ]; then rm -f /var/lib/reef/reef.sqlite-wal /var/lib/reef/reef.sqlite-shm; cp "$reef_backup/reef.sqlite" /var/lib/reef/reef.sqlite; chown reef:reef /var/lib/reef/reef.sqlite; chmod 600 /var/lib/reef/reef.sqlite; fi
  systemctl start reef || true
 fi
 echo "Обновление не завершилось. Предыдущая версия восстановлена. Резервная копия: $reef_backup"
 exit "$reef_status"
}
trap rollback ERR
systemctl stop reef
reef_stopped=1
sqlite3 /var/lib/reef/reef.sqlite ".backup '$reef_backup/reef.tmp.sqlite'"
mv "$reef_backup/reef.tmp.sqlite" "$reef_backup/reef.sqlite"
cp /etc/reef/reef.json "$reef_backup/reef.json"
mv /opt/reef "$reef_previous"
reef_swapped=1
mv "$reef_stage" /opt/reef
systemctl start reef
reef_healthy=0
for reef_attempt in $(seq 1 15); do
 if curl -fsS --max-time 3 http://127.0.0.1:3300/reef-api/me >/dev/null 2>&1; then reef_healthy=1; break; fi
 sleep 1
done
[ "$reef_healthy" = 1 ]
trap - ERR
echo "Reef обновлён. Аккаунты, посты, фотографии и настройки сохранены."
echo "Копия базы и настроек: $reef_backup"
echo "После открытия сайта обновите страницу, чтобы загрузить новый интерфейс."
