
WhatsApp Bot Advanced - Ready for Render
=======================================

Files:
- index.js : main bot
- package.json : dependencies and start script

Deploy steps (mobile):
1. Create a GitHub repo and upload these two files.
2. On Render, create a new Web Service -> Deploy from GitHub and choose this repo.
3. Build command: `npm install`
4. Start command: `npm start`
5. After deploy, open Logs to see the QR ASCII. You can also download the QR image (if created) at /qr.png endpoint of your service.

Notes:
- The bot saves media to /data folder and serves files at /files/:name
- LocalAuth stores session in /sessions (should persist across deploys if supported by host)
