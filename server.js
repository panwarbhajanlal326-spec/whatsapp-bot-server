import express from 'express';
import makeWASocket, { DisconnectReason, useMultiFileAuthState, Browsers } from '@whiskeysockets/baileys';
import pino from 'pino';
import QRCode from 'qrcode';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let sock = null;
let currentQR = null;
let isConnected = false;
const activeTargets = new Set();

// App se control hone wale dynamic variables
let currentMessage = "Automated reply: Yeh system generated message hai.";
let currentDelayMs = 3000; // Default 3 second

async function startWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

    sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        browser: Browsers.ubuntu('Chrome'),
        syncFullHistory: false
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            try {
                currentQR = await QRCode.toDataURL(qr);
                console.log("[QR] Naya QR ready hai.");
            } catch (err) {
                console.error("[QR Error]", err);
            }
        }

        if (connection === 'close') {
            isConnected = false;
            currentQR = null;
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            console.log(`Connection closed (code: ${statusCode}). Reconnecting: ${shouldReconnect}`);
            if (shouldReconnect) {
                startWhatsApp();
            }
        } else if (connection === 'open') {
            isConnected = true;
            currentQR = null;
            console.log("✅ WhatsApp Connected!");
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg || !msg.message) return;

        if (!msg.key.fromMe) return;

        const targetChat = msg.key.remoteJid;
        if (!targetChat || targetChat.endsWith('@g.us')) return;

        const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
        const cleanText = text.toLowerCase().trim();

        if (cleanText === 'stop' || cleanText === 'x') {
            if (activeTargets.has(targetChat)) {
                activeTargets.delete(targetChat);
                console.log(`[STOP] Loop band: ${targetChat}`);
                try {
                    await sock.sendMessage(targetChat, { text: "🛑 Loop stopped." });
                } catch (e) {}
            }
            return;
        }

        if (cleanText === 'z') {
            if (!activeTargets.has(targetChat)) {
                activeTargets.add(targetChat);
                console.log(`[START] Loop shuru: ${targetChat}`);

                (async () => {
                    while (activeTargets.has(targetChat) && isConnected) {
                        try {
                            // Dynamic message send karein
                            await sock.sendMessage(targetChat, { text: currentMessage });
                            console.log(`[SENT] Message bhej diya: ${targetChat}`);
                        } catch (err) {
                            console.error("[SEND ERROR]", err);
                            activeTargets.delete(targetChat);
                            break;
                        }
                        // Dynamic delay follow karein
                        await sleep(currentDelayMs);
                    }
                })();
            }
        }
    });
}

startWhatsApp();

// API: Config fetch karna
app.get('/config', (req, res) => {
    res.json({
        message: currentMessage,
        delaySeconds: currentDelayMs / 1000
    });
});

// API: App se naya message aur delay set karna
app.post('/config', (req, res) => {
    const { message, delaySeconds } = req.body;
    if (message && message.trim()) {
        currentMessage = message.trim();
    }
    if (delaySeconds && !isNaN(delaySeconds)) {
        let sec = parseFloat(delaySeconds);
        if (sec < 2) sec = 2; // WhatsApp ban se bachne ke liye minimum 2s
        currentDelayMs = sec * 1000;
    }
    console.log(`[CONFIG UPDATE] Msg: "${currentMessage}", Delay: ${currentDelayMs}ms`);
    res.json({ success: true, message: currentMessage, delaySeconds: currentDelayMs / 1000 });
});

app.get('/status', (req, res) => {
    res.json({
        connected: isConnected,
        activeChats: Array.from(activeTargets)
    });
});

app.get('/qr', (req, res) => {
    if (isConnected) {
        return res.json({ status: "connected", qr: null });
    }
    if (!currentQR) {
        return res.json({ status: "waiting", qr: null, message: "QR ban raha hai..." });
    }
    return res.json({ status: "ready", qr: currentQR });
});

app.get('/', (req, res) => {
    res.send("WhatsApp Bot Service Running!");
});

app.listen(PORT, () => {
    console.log(`Server port ${PORT} active`);
});
