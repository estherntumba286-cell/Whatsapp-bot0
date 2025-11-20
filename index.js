/**
 * Advanced WhatsApp bot (whatsapp-web.js) - Ready for Render / GitHub
 * Features:
 * - sticker -> image conversion
 * - download image from URL command (!dl <url>)
 * - save view-once images automatically
 * - tag all members in group (!tagall)
 * - simple command handler and admin commands
 * - generates qr.png and serves it via HTTP for easy scanning
 *
 * Notes:
 * - This runs with LocalAuth so sessions persist (when supported by host).
 * - On Render free tier, use GitHub deploy. The server exposes:
 *    GET /qr.png    -> latest QR image (if generated)
 *    GET /files/:name -> download saved media from /data folder
 */

const fs = require('fs');
const path = require('path');
const express = require('express');
const qrcode = require('qrcode-terminal');
const QR = require('qrcode');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const axios = require('axios');
const sharp = require('sharp');
const NodeCache = require('node-cache');

require('dotenv').config();

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

const app = express();
app.get('/', (req, res) => res.send('WhatsApp Bot (Advanced) is running'));
app.get('/qr.png', (req, res) => {
  const qrPath = path.join(DATA_DIR, 'qr.png');
  if (fs.existsSync(qrPath)) return res.sendFile(qrPath);
  return res.status(404).send('No QR generated yet.');
});
app.get('/files/:name', (req, res) => {
  const file = path.join(DATA_DIR, path.basename(req.params.name));
  if (fs.existsSync(file)) return res.sendFile(file);
  return res.status(404).send('File not found.');
});
app.listen(PORT, () => console.log(`HTTP server listening on port ${PORT}`));

// Simple in-memory cache for last generated items
const cache = new NodeCache({ stdTTL: 600 });

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: './sessions' }),
  puppeteer: {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu'
    ]
  }
});

// Display QR in logs and also save to file /data/qr.png (useful if Render can serve files)
client.on('qr', async (qr) => {
  console.log('QR received — generating ascii and qr.png');
  qrcode.generate(qr, { small: true });
  try {
    // Save qr to file (PNG)
    await QR.toFile(path.join(DATA_DIR, 'qr.png'), qr);
    cache.set('qr', 'qr.png');
    console.log('Saved QR to /data/qr.png — you can download it at /qr.png');
  } catch (e) {
    console.error('Failed to write qr.png:', e);
  }
});

client.on('ready', () => {
  console.log('Client is ready!');
});

// Utility: download media from MessageMedia or URL
async function downloadMediaToFile(media, filename) {
  const buffer = Buffer.from(media.data, 'base64');
  const outPath = path.join(DATA_DIR, filename);
  await fs.promises.writeFile(outPath, buffer);
  return outPath;
}
async function downloadUrlToFile(url, filename) {
  const resp = await axios.get(url, { responseType: 'arraybuffer' });
  const outPath = path.join(DATA_DIR, filename);
  await fs.promises.writeFile(outPath, Buffer.from(resp.data));
  return outPath;
}

// Convert sticker (webp) buffer to png and save
async function convertStickerBufferToPng(base64Data, outName) {
  const buffer = Buffer.from(base64Data, 'base64');
  const pngBuffer = await sharp(buffer).png().toBuffer();
  const outPath = path.join(DATA_DIR, outName);
  await fs.promises.writeFile(outPath, pngBuffer);
  return outPath;
}

// Helper: send media file by path to chat
async function sendFileToChat(chat, filePath, caption) {
  const data = await fs.promises.readFile(filePath);
  const mime = 'image/png';
  const b64 = Buffer.from(data).toString('base64');
  const media = new MessageMedia(mime, b64);
  await chat.sendMessage(media, { caption });
}

// Basic command handler
client.on('message', async (msg) => {
  try {
    const chat = await msg.getChat();
    const from = msg.from;
    const body = (msg.body || '').trim();

    console.log(`Message from ${from}:`, body);

    // Commands:
    // !dl <url> -> download image from URL and send back
    if (body.startsWith('!dl ')) {
      const parts = body.split(' ');
      const url = parts[1];
      if (!url) return msg.reply('Usage: !dl <image_url>');
      try {
        const fileName = `dl_${Date.now()}.jpg`;
        await downloadUrlToFile(url, fileName);
        await sendFileToChat(chat, path.join(DATA_DIR, fileName), 'Voilà l\'image téléchargée');
      } catch (e) {
        console.error('Download error', e);
        msg.reply('Erreur durant le téléchargement.');
      }
      return;
    }

    // !sticker2img (reply to sticker) - convert sticker to image
    if (body === '!sticker2img') {
      // if the message is a reply to a sticker, get that message
      const quoted = msg.hasQuotedMsg && await msg.getQuotedMessage();
      const target = quoted || msg;
      if (target.type !== 'sticker') return msg.reply('Réponds à un sticker avec la commande !sticker2img');
      const media = await target.downloadMedia();
      if (!media) return msg.reply('Impossible de télécharger le sticker.');
      const fileName = `sticker_${Date.now()}.png`;
      await convertStickerBufferToPng(media.data, fileName);
      await sendFileToChat(chat, path.join(DATA_DIR, fileName), 'Sticker converti en image');
      return;
    }

    // Tag all in group
    if (body === '!tagall') {
      if (!chat.isGroup) return msg.reply('Cette commande fonctionne seulement dans un groupe.');
      let text = '📣 TAG ALL\n';
      const mentions = [];
      for (const p of chat.participants) {
        mentions.push(p.id._serialized);
        text += `@${p.id.user} `;
      }
      await chat.sendMessage(text, { mentions });
      return;
    }

    // admin simple: !listfiles -> list saved files
    if (body === '!listfiles') {
      const files = await fs.promises.readdir(DATA_DIR);
      return msg.reply('Fichiers: ' + files.join(', '));
    }

    // auto-save media messages (images, audio, videos, stickers, view-once)
    if (msg.type === 'image' || msg.type === 'video' || msg.type === 'audio' || msg.type === 'sticker' || msg.isViewOnce) {
      try {
        const media = await msg.downloadMedia();
        if (media && media.data) {
          const ext = (msg.type === 'sticker') ? 'webp' : (msg.mimetype ? msg.mimetype.split('/').pop() : 'bin');
          const filename = `${msg.type}_${Date.now()}.${ext}`;
          const saved = await downloadMediaToFile(media, filename);
          console.log('Saved media to', saved);
          // If view-once, notify sender
          if (msg.isViewOnce) {
            await msg.reply('📥 Image vue-unique sauvegardée.');
          }
        }
      } catch (e) {
        console.error('Error saving media', e);
      }
    }

    // simple greet
    if (body.toLowerCase() === 'bonjour' || body.toLowerCase() === 'salut') {
      return msg.reply('Salut 👋 — bot avancé en place. Utilise !help pour commandes.');
    }

    if (body === '!help') {
      const help = [
        'Commandes disponibles:',
        '!dl <url> - télécharger image depuis URL',
        '!sticker2img - réponds à un sticker pour le convertir (reply)',
        '!tagall - tague tout le groupe',
        '!listfiles - liste les fichiers sauvegardés',
        '/qr.png - télécharge le dernier QR (via HTTP)'
      ].join('\n');
      return msg.reply(help);
    }

  } catch (err) {
    console.error('Message handler error', err);
  }
});

client.initialize();
