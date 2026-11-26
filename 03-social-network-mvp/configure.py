import os,json,secrets,getpass,re
from pathlib import Path
p=Path('/etc/reef/reef.json')
p.parent.mkdir(mode=0o700,parents=True,exist_ok=True)
if p.exists():
 print('Настройки уже созданы. Для повторной настройки используйте /etc/reef/reef.json; существующие ключи не меняются.')
 raise SystemExit(0)
domain=input('Домен Reef: ').strip()
if not re.fullmatch(r'[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?',domain):raise SystemExit('Некорректный домен')
owner=input('Почта владельца: ').strip().lower()
sender=input('Почта отправителя Mail.ru: ').strip().lower()
for email in (owner,sender):
 if not re.fullmatch(r'[^\s@<>,;:"\\]+@[a-z0-9.-]+\.[a-z]{2,}',email):raise SystemExit('Некорректная почта')
password=getpass.getpass('Пароль приложения Mail.ru (ввод скрыт): ')
if not password:raise SystemExit('Пароль не введён')
values={'REEF_ORIGIN':'https://'+domain,'REEF_OWNER_EMAIL':owner,'REEF_OWNER_NAME':'Владелец','REEF_PASSWORD_PEPPER':secrets.token_urlsafe(48),'REEF_DATA_DIR':'/var/lib/reef','SMTP_HOST':'smtp.mail.ru','SMTP_PORT':'465','SMTP_USER':sender,'SMTP_PASSWORD':password,'REEF_PUSH_SUBJECT':'https://'+domain,'PORT':'3300'}
fd=os.open(p,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
with os.fdopen(fd,'w') as f:
 json.dump(values,f,ensure_ascii=False,indent=2);f.write('\n')
print('Настройки сохранены. Пароль не выводится и не передаётся в историю команд.')
