require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode-terminal');

// Suppress verbose Baileys internal session/crypto logs
const _origLog = console.log.bind(console);
console.log = (...args) => {
    const msg = args[0];
    if (typeof msg === 'string' && (
        msg.includes('Closing session') ||
        msg.includes('_chains') ||
        msg.includes('ephemeralKeyPair') ||
        msg.includes('registrationId') ||
        msg.includes('currentRatchet') ||
        msg.includes('indexInfo') ||
        msg.includes('baseKeyType') ||
        msg.includes('remoteIdentityKey') ||
        msg.includes('rootKey') ||
        msg.includes('privKey') ||
        msg.includes('pubKey') ||
        msg.includes('previousCounter')
    )) return;
    _origLog(...args);
};

const app = express();
app.use(express.json());

const WORKER_SECRET = process.env.WORKER_SECRET || 'super_secret_key';
const PORT = process.env.PORT || 4000;
// AI service base URL – strip any trailing path like /api/generate
const AI_BASE_URL = (process.env.AI_SERVICE_URL || 'https://sound-scout-ai.onrender.com')
    .replace(/\/api\/.*$/, '').replace(/\/$/, '');

let sock;
let isConnected = false;

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('baileys_auth_info');
    
    let version = [2, 3000, 1017578297]; // modern fallback version
    try {
        const latest = await fetchLatestBaileysVersion();
        version = latest.version;
        console.log(`Using WhatsApp Web Version: ${version.join('.')}`);
    } catch (e) {
        console.warn(`Failed to fetch latest Baileys version, using fallback: ${e.message}`);
    }

    sock = makeWASocket({
        auth: state,
        version,
        logger: pino({ level: 'silent' }),
        browser: ["SoundScout Worker", "Chrome", "1.0.0"],
        connectTimeoutMs: 60000,
        keepAliveIntervalMs: 25000
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            console.log('⚡ Scan the QR Code above to link WhatsApp');
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'close') {
            isConnected = false;
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            console.log(`🔴 Connection closed (status: ${statusCode}, error: ${lastDisconnect?.error?.message || lastDisconnect?.error}), reconnecting:`, shouldReconnect);
            if (shouldReconnect) {
                setTimeout(() => connectToWhatsApp(), 3000);
            }
        } else if (connection === 'open') {
            isConnected = true;
            console.log('✅ WhatsApp Worker is LIVE and ready!');
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        if (m.type !== 'notify') return;
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const from = msg.key.remoteJid;
        if (from === 'status@broadcast') return;

        const text = msg.message.conversation || msg.message.extendedTextMessage?.text;
        if (!text) return;

        try {
            const aiResponse = await axios.post(`${AI_BASE_URL}/api/support`, {
                session_id: from,
                user_jid: from,
                message: text
            });
            if (aiResponse.data && aiResponse.data.reply) {
                await sock.sendMessage(from, { text: aiResponse.data.reply });
                console.log(`💬 Replied to ${from}`);
            }
        } catch (error) {
            console.error('AI Proxy Error:', error.message);
        }
    });
}

// Express API Endpoints
app.get('/', (req, res) => {
    res.status(200).json({ 
        status: 'WhatsApp Worker is running! 🚀', 
        connected: isConnected 
    });
});

app.post('/api/send-message', async (req, res) => {
    const { secret, phone, message } = req.body;

    if (secret !== WORKER_SECRET) {
        return res.status(403).json({ error: 'Unauthorized' });
    }

    if (!sock || !isConnected) {
        return res.status(503).json({ 
            error: isConnected ? 'WhatsApp socket not initialized' : 'WhatsApp is not connected yet. Please wait or re-scan QR.' 
        });
    }

    try {
        let jid = String(phone || '').replace(/\D/g, '');
        if (jid.startsWith('0')) jid = '94' + jid.substring(1);
        else if (jid.length === 9 && jid.startsWith('7')) jid = '94' + jid;
        jid = `${jid}@s.whatsapp.net`;

        console.log(`📤 Sending WhatsApp message to ${jid}`);
        await sock.sendMessage(jid, { text: message });
        res.status(200).json({ success: true, message: 'Dispatched successfully' });
    } catch (error) {
        console.error('Send message error:', error.message);
        res.status(500).json({ error: 'Failed to send message', details: error.message });
    }
});

app.listen(PORT, () => {
    console.log(`📡 Worker API listening on port ${PORT}`);
    connectToWhatsApp();

    // Keep-alive: ping ourselves and the AI service every 10 min to
    // prevent Render free-tier from spinning either service down
    const WORKER_URL = process.env.RENDER_EXTERNAL_URL || '';
    setInterval(async () => {
        try {
            if (WORKER_URL) await axios.get(WORKER_URL + '/');
            await axios.get(AI_BASE_URL + '/');
            console.log('🔄 Keep-alive pings sent to worker + AI service');
        } catch (e) {
            console.warn('⚠️  Keep-alive ping failed:', e.message);
        }
    }, 600000); // every 10 minutes
});