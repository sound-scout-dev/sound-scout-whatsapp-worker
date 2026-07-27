require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode-terminal');

const app = express();
app.use(express.json());

const WORKER_SECRET = process.env.WORKER_SECRET || 'super_secret_key';
const PORT = process.env.PORT || 4000;

let sock;

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('baileys_auth_info');

    sock = makeWASocket({
        auth: state,
        // Suppress massive Baileys connection logs
        logger: pino({ level: 'silent' }),
        browser: ["SoundScout Worker", "Chrome", "1.0.0"]
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            console.log('⚡ Scan the QR Code above to link WhatsApp');
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'close') {
            const shouldReconnect = lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('🔴 Connection closed, reconnecting:', shouldReconnect);
            if (shouldReconnect) {
                connectToWhatsApp();
            }
        } else if (connection === 'open') {
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
            if (process.env.AI_SERVICE_URL) {
                const aiResponse = await axios.post(`${process.env.AI_SERVICE_URL}/api/support`, {
                    user_jid: from,
                    message: text
                });
                if (aiResponse.data && aiResponse.data.reply) {
                    await sock.sendMessage(from, { text: aiResponse.data.reply });
                }
            }
        } catch (error) {
            console.error('AI Proxy Error:', error.message);
        }
    });
}

// Express API Endpoint for Backend Dispatch
app.post('/api/send-message', async (req, res) => {
    const { secret, phone, message } = req.body;

    if (secret !== WORKER_SECRET) {
        return res.status(403).json({ error: 'Unauthorized' });
    }

    if (!sock) {
        return res.status(500).json({ error: 'WhatsApp socket not initialized' });
    }

    try {
        let jid = phone.replace(/\D/g, '');
        if (jid.startsWith('0')) jid = '94' + jid.substring(1);
        // Baileys uses s.whatsapp.net instead of c.us
        jid = `${jid}@s.whatsapp.net`; 

        await sock.sendMessage(jid, { text: message });
        res.status(200).json({ success: true, message: 'Dispatched successfully' });
    } catch (error) {
        console.error('Send message error:', error.message);
        res.status(500).json({ error: 'Failed to send message' });
    }
});

app.listen(PORT, () => {
    console.log(`📡 Worker API listening on port ${PORT}`);
    connectToWhatsApp();
});