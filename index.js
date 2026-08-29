require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode-terminal');

// ── Suppress verbose Baileys internal session/crypto logs ──────────────────────
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
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
    if (req.method === 'OPTIONS') {
        res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH');
        return res.status(200).json({});
    }
    next();
});
app.use(express.json());

const WORKER_SECRET = process.env.WORKER_SECRET || 'super_secret_key';
const MAIN_BACKEND_URL = (process.env.MAIN_BACKEND_URL || process.env.BACKEND_SERVICE_URL || 'https://sound-scout-backend.onrender.com').replace(/\/$/, '');
const PORT = process.env.PORT || 4000;
const AI_BASE_URL = (process.env.AI_SERVICE_URL || 'https://sound-scout-ai.onrender.com')
    .replace(/\/api\/.*$/, '').replace(/\/$/, '');

let sock;
let isConnected = false;

// ── Message Queue: hold outbound messages while socket is not stable ───────────
const messageQueue = [];
let connectionStableAt = 0;
const STABILITY_DELAY_MS = 4000;

// ── Pending OTP Store: keyed by normalised phone number ────────────────────────
// When a user hasn't messaged before, we store their OTP here.
// The moment they send any message to the linked number, we deliver it.
// TTL: 10 minutes.
const pendingOTPs = {}; // { '94762567546': { message: '...', expiresAt: Date } }

function normPhone(phone) {
    let n = String(phone || '').replace(/\D/g, '');
    if (n.startsWith('0')) n = '94' + n.substring(1);
    else if (n.length === 9 && n.startsWith('7')) n = '94' + n;
    return n;
}

function isSocketReady() {
    return isConnected && sock && (Date.now() - connectionStableAt >= STABILITY_DELAY_MS);
}

async function flushMessageQueue() {
    if (!isSocketReady() || messageQueue.length === 0) return;
    console.log(`📬 Flushing ${messageQueue.length} queued message(s)...`);
    while (messageQueue.length > 0) {
        const { jid, message, resolve, reject } = messageQueue.shift();
        try {
            await sock.sendMessage(jid, { text: message });
            console.log(`✅ Queued message delivered to ${jid}`);
            resolve({ success: true });
        } catch (err) {
            console.error(`❌ Failed to deliver queued message to ${jid}:`, err.message);
            reject(err);
        }
    }
}

async function sendWhatsAppMessage(jid, message) {
    if (!isSocketReady()) {
        console.log(`⏳ Socket not ready — queuing message for ${jid}`);
        return new Promise((resolve, reject) => {
            messageQueue.push({ jid, message, resolve, reject });
            setTimeout(() => reject(new Error('Socket never became ready within 30s')), 30000);
        });
    }
    await sock.sendMessage(jid, { text: message });
    console.log(`✅ Message delivered to ${jid}`);
}

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('baileys_auth_info');
    
    let version = [2, 3000, 1017578297];
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
            connectionStableAt = 0;
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            console.log(`🔴 Connection closed (status: ${statusCode}, error: ${lastDisconnect?.error?.message || lastDisconnect?.error}), reconnecting:`, shouldReconnect);
            if (shouldReconnect) {
                setTimeout(() => connectToWhatsApp(), 3000);
            }
        } else if (connection === 'open') {
            isConnected = true;
            connectionStableAt = Date.now();
            console.log(`✅ WhatsApp Worker is LIVE and ready! Waiting ${STABILITY_DELAY_MS / 1000}s for connection to stabilise...`);
            setTimeout(flushMessageQueue, STABILITY_DELAY_MS);
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        if (m.type !== 'notify') return;
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const from = msg.key.remoteJid;
        if (from === 'status@broadcast') return;

        const rawText = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
        const cleanText = rawText.trim().toUpperCase();
        if (!cleanText) return;

        const senderPhone = from.split('@')[0].split(':')[0].replace(/\D/g, '');

        // ── Click-to-Verify handler: process VERIFY- and RESET- codes sent by user ───────
        if (cleanText.startsWith('VERIFY-') || cleanText.startsWith('RESET-')) {
            const extractedCode = cleanText.split(/\s+/)[0];
            console.log(`🔐 Verification/Reset code ${extractedCode} received from ${senderPhone} (raw: ${msg.key.remoteJid})`);

            try {
                const response = await axios.post(`${MAIN_BACKEND_URL}/api/users/verify-code`, {
                    secret: WORKER_SECRET,
                    code: extractedCode,
                    phone: senderPhone
                });

                if (response.data && response.data.success) {
                    const isReset = extractedCode.startsWith('RESET-');
                    const successMsg = isReset
                        ? "✅ *Code Confirmed!* Your identity has been verified via WhatsApp. You can return to your browser to set your new password."
                        : "✅ *Account Verified!* Your SoundScout account is now fully activated. You can return to your browser to log in.";
                    await sendWhatsAppMessage(from, successMsg);
                    return;
                } else {
                    await sendWhatsAppMessage(
                        from,
                        "❌ *Verification Failed.* Invalid or expired code. Please try registering again on the website."
                    );
                    return;
                }
            } catch (err) {
                const errMsg = err.response?.data?.message || "Invalid or expired code. Please send the code from your registered WhatsApp number.";
                console.error(`❌ Verification error for code ${extractedCode}:`, errMsg);
                await sendWhatsAppMessage(
                    from,
                    `❌ *Verification Failed.*\n\n${errMsg}`
                );
                return;
            }
        }

        // ── Pending OTP delivery: if this number has a queued OTP, send it now ──
        const pending = pendingOTPs[senderPhone];
        if (pending) {
            if (Date.now() < pending.expiresAt) {
                console.log(`📨 User ${senderPhone} messaged first — delivering queued OTP now`);
                try {
                    await sendWhatsAppMessage(from, pending.message);
                    delete pendingOTPs[senderPhone];
                } catch (err) {
                    console.error(`❌ Failed to deliver pending OTP to ${from}:`, err.message);
                }
                return; // Don't forward to AI support for this first message
            } else {
                console.log(`⏰ Pending OTP for ${senderPhone} has expired — discarding`);
                delete pendingOTPs[senderPhone];
            }
        }

        // ── Forward to AI support agent ────────────────────────────────────────
        try {
            const aiResponse = await axios.post(`${AI_BASE_URL}/api/support`, {
                session_id: from,
                user_jid: from,
                message: rawText
            });
            if (aiResponse.data && aiResponse.data.reply) {
                await sendWhatsAppMessage(from, aiResponse.data.reply);
                console.log(`💬 Replied to ${from}`);
            }
        } catch (error) {
            console.error('AI Proxy Error:', error.message);
        }
    });
}

function extractValidPhone(raw) {
    if (!raw) return '94703252870';
    const str = String(raw);
    if (str.includes('@lid') || str.replace(/\D/g, '').length >= 14) {
        return '94703252870';
    }
    let digits = str.split(':')[0].split('@')[0].replace(/\D/g, '');
    if (digits.startsWith('0')) digits = '94' + digits.substring(1);
    else if (digits.length === 9 && digits.startsWith('7')) digits = '94' + digits;
    
    if (digits.length >= 9 && digits.length <= 13) {
        return digits;
    }
    return '94703252870';
}

// ── Express API Endpoints ──────────────────────────────────────────────────────
app.get('/', (req, res) => {
    const rawBotId = sock?.user?.id || null;
    const botPhone = extractValidPhone(rawBotId);

    res.status(200).json({ 
        status: 'WhatsApp Worker is running! 🚀', 
        connected: isConnected,
        socketReady: isSocketReady(),
        botPhone: botPhone,
        queueLength: messageQueue.length,
        pendingOTPs: Object.keys(pendingOTPs).length
    });
});

// POST /api/send-message — direct send (for non-first-time users)
app.post('/api/send-message', async (req, res) => {
    const { secret, phone, message } = req.body;

    if (secret !== WORKER_SECRET) {
        return res.status(403).json({ error: 'Unauthorized' });
    }

    if (!sock) {
        return res.status(503).json({ error: 'WhatsApp socket not initialized.' });
    }
    if (!isConnected) {
        return res.status(503).json({ error: 'WhatsApp is not connected. Please wait or re-scan QR.' });
    }

    try {
        const normalised = normPhone(phone);
        const jid = `${normalised}@s.whatsapp.net`;

        console.log(`📤 Sending WhatsApp message to ${jid} (socketReady=${isSocketReady()}, queueSize=${messageQueue.length})`);
        await sendWhatsAppMessage(jid, message);
        res.status(200).json({ success: true, message: 'Dispatched successfully' });
    } catch (error) {
        console.error(`❌ Send message error to ${phone}:`, error.message);
        res.status(500).json({ error: 'Failed to send message', details: error.message });
    }
});

// POST /api/queue-otp — store OTP for first-time users who haven't messaged before.
// The OTP will be delivered the moment they send any message to the linked number.
app.post('/api/queue-otp', async (req, res) => {
    const { secret, phone, message } = req.body;

    if (secret !== WORKER_SECRET) {
        return res.status(403).json({ error: 'Unauthorized' });
    }

    const normalised = normPhone(phone);
    pendingOTPs[normalised] = {
        message,
        expiresAt: Date.now() + 10 * 60 * 1000 // 10 minutes TTL
    };
    console.log(`📋 OTP queued for first-time user ${normalised} (expires in 10min)`);
    res.status(200).json({ 
        success: true, 
        instruction: `Ask the user to send any message to your WhatsApp number. Their OTP will be auto-delivered.`
    });
});

app.listen(PORT, () => {
    console.log(`📡 Worker API listening on port ${PORT}`);
    connectToWhatsApp();

    const WORKER_URL = process.env.RENDER_EXTERNAL_URL || '';
    setInterval(async () => {
        try {
            if (WORKER_URL) await axios.get(WORKER_URL + '/');
            await axios.get(AI_BASE_URL + '/');
            console.log('🔄 Keep-alive pings sent to worker + AI service');
        } catch (e) {
            console.warn('⚠️  Keep-alive ping failed:', e.message);
        }
    }, 600000);
});