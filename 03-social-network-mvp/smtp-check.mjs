import nodemailer from 'nodemailer';
import {readFile} from 'node:fs/promises';
const config=JSON.parse(await readFile(process.argv[2]||'/etc/reef/reef.json','utf8'));
const mail=nodemailer.createTransport({host:config.SMTP_HOST,port:Number(config.SMTP_PORT||465),secure:true,auth:{user:config.SMTP_USER,pass:config.SMTP_PASSWORD},connectionTimeout:10000,socketTimeout:15000});try{await mail.verify();console.log('Соединение с Mail.ru и пароль приложения проверены.')}catch(e){console.error('Проверка SMTP не прошла: '+String(e.code||'SMTP_ERROR').replace(/[^A-Z0-9_]/g,''));process.exitCode=1}finally{mail.close()}
