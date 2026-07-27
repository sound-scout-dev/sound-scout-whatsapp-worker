require('dotenv').config();
const express = require('express');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const axios = require('axios');

const app = express();
app.use(express.json());

const WORKER_SECRET = process.env.WORKER_SECRET || 'super_secret_key';

const client = new Client({
    authStrategy: new LocalAuth({
        dataPath: './.wwebjs_auth'
    }),
    // Pinning to a highly stable, older WhatsApp Web version
    webVersionCache: {
        type: 'remote',
        remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html',
    },
    puppeteer: {
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
        headless: true,
        dumpio: true, // 🚨 CRITICAL: Forces Chromium to print internal browser errors to Render logs
        timeout: 60000,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--disable-gpu',
            '--no-first-run',
            '--no-zygote'
        ]
    }
});

// --- EVENT LISTENERS MUST BE REGISTERED BEFORE INITIALIZE ---

client.on('qr', (qr) => {
    qrcode.generate(qr, { small: true });
    console.log('⚡ Scan the QR Code above to link WhatsApp');
});

client.on('authenticated', () => {
    console.log('🔑 WhatsApp Authenticated successfully!');
});

client.on('loading_screen', (percent, message) => {
    console.log(`⏳ WhatsApp Syncing: ${percent}% - ${message}`);
});

client.on('ready', () => {
    console.log('✅ WhatsApp Worker is LIVE and ready!');
});

client.on('auth_failure', (msg) => {
    console.error('❌ Authentication Failure:', msg);
});

client.on('disconnected', (reason) => {
    console.log('🔴 Client Disconnected:', reason);
});

// Incoming message handler
client.on('message', async (msg) => {
    if (msg.from === 'status@broadcast') return;

    try {
        if (process.env.AI_SERVICE_URL) {
            const aiResponse = await axios.post(`${process.env.AI_SERVICE_URL}/api/support`, {
                user_jid: msg.from,
                message: msg.body
            });
            if (aiResponse.data && aiResponse.data.reply) {
                client.sendMessage(msg.from, aiResponse.data.reply);
            }
        }
    } catch (error) {
        console.error('AI Proxy Error:', error.message);
    }
});

// Express API Endpoint for Backend Dispatch
app.post('/api/send-message', async (req, res) => {
    const { secret, phone, message } = req.body;

    if (secret !== WORKER_SECRET) {
        return res.status(403).json({ error: 'Unauthorized' });
    }

    try {
        let jid = phone.replace(/\D/g, '');
        if (jid.startsWith('0')) jid = '94' + jid.substring(1);
        jid = `${jid}@c.us`;

        await client.sendMessage(jid, message);
        res.status(200).json({ success: true, message: 'Dispatched successfully' });
    } catch (error) {
        console.error('Send message error:', error.message);
        res.status(500).json({ error: 'Failed to send message' });
    }
});

// START CLIENT AND SERVER
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
    console.log(`📡 Worker API listening on port ${PORT}`);
    console.log('🔄 Initializing WhatsApp Client...');
    client.initialize();
});