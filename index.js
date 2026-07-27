// whatsapp-worker/index.js
require('dotenv').config();
const express = require('express');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const axios = require('axios');

const app = express();
app.use(express.json());

// Security: Prevent unauthorized pings to your worker
const WORKER_SECRET = process.env.WORKER_SECRET || 'super_secret_key';

const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--single-process',
            '--disable-gpu'
        ]
    }
});

client.on('qr', (qr) => {
    qrcode.generate(qr, { small: true });
    console.log('⚡ Scan the QR Code above to link WhatsApp');
});

client.on('ready', () => {
    console.log('✅ WhatsApp Worker is LIVE and ready!');
});

// Route incoming WhatsApp messages to your Flask AI
client.on('message', async (msg) => {
    if (msg.from === 'status@broadcast') return;

    try {
        const aiResponse = await axios.post(`${process.env.AI_SERVICE_URL}/api/support`, {
            user_jid: msg.from,
            message: msg.body
        });
        client.sendMessage(msg.from, aiResponse.data.reply);
    } catch (error) {
        console.error('AI Proxy Error:', error.message);
    }
});

client.initialize();

// API Endpoint for the Main Backend to trigger messages
app.post('/api/send-message', async (req, res) => {
    const { secret, phone, message } = req.body;

    if (secret !== WORKER_SECRET) {
        return res.status(403).json({ error: 'Unauthorized' });
    }

    try {
        // Format local SL numbers to JID
        let jid = phone.replace(/\D/g, '');
        if (jid.startsWith('0')) jid = '94' + jid.substring(1);
        jid = `${jid}@c.us`;

        await client.sendMessage(jid, message);
        res.status(200).json({ success: true, message: 'Dispatched successfully' });
    } catch (error) {
        res.status(500).json({ error: 'Failed to send message' });
    }
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`📡 Worker API listening on port ${PORT}`));