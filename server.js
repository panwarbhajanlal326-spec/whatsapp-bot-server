import express from 'express';
import makeWASocket, { DisconnectReason, useMultiFileAuthState } from '@whiskeysockets/baileys';
import pino from 'pino';
import QRCode from 'qrcode';

const app = express();
const PORT = process.env.PORT || 3000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let sock = null;
let currentQR = null;
let isConnected = false;
const activeTargets = new Set();

// Ye message loop me bheja jayega
const defaultMessage = "Automated reply: Yeh system generated message hai.";

async function startWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

    sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            try {
                // QR string ko Base64 Image URL me badalna taaki app display kar sake
                currentQR = await QRCode.toDataURL(qr);
                console.log("[QR] Naya QR code ready hai.");
            } catch (err) {
                console.error("[QR Error]", err);
            }
        }

        if (connection === 'close') {
            isConnected = false;
            currentQR = null;
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            console.log(`Connection band hua (Code: ${statusCode}). Reconnecting: ${shouldReconnect}`);
            if (shouldReconnect) {
                startWhatsApp();
            }
        } else if (connection === 'open') {
            isConnected = true;
            currentQR = null;
            console.log("✅ WhatsApp successfully connect ho gaya!");
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg || !msg.message) return;

        // Sirf apne account se bheje gaye message track karein
        if (!msg.key.fromMe) return;

        const targetChat = msg.key.remoteJid;
        if (!targetChat || targetChat.endsWith('@g.us')) return; // Group messages ignore karein

        const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
        const cleanText = text.toLowerCase().trim();

        // Agar "x" ya "stop" bheja ho
        if (cleanText === 'stop' || cleanText === 'x') {
            if (activeTargets.has(targetChat)) {
                activeTargets.delete(targetChat);
                console.log(`[STOP] Loop band kiya gaya: ${targetChat}`);
                try {
                    await sock.sendMessage(targetChat, { text: "🛑 Loop stopped." });
                } catch (e) {}
            }
            return;
        }

        // Agar "z" bheja ho
        if (cleanText === 'z') {
            if (!activeTargets.has(targetChat)) {
                activeTargets.add(targetChat);
                console.log(`[START] Loop shuru hua: ${targetChat}`);

                (async () => {
                    while (activeTargets.has(targetChat) && isConnected) {
                        try {
                            await sock.sendMessage(targetChat, { text: defaultMessage });
                            console.log(`[SENT] Message bhej diya: ${targetChat}`);
                        } catch (err) {
                            console.error("[SEND ERROR]", err);
                            activeTargets.delete(targetChat);
                            break;
                        }
                        // 3 second ka gap taaki WhatsApp number ban na kare
                        await sleep(3000);
                    }
                })();
            }
        }
    });
}

// Bot instance shuru karein
startWhatsApp();

// --- Endpoints Android App ke liye ---

// 1. Connection status check karne ka endpoint
app.get('/status', (req, res) => {
    res.json({
        connected: isConnected,
        activeChats: Array.from(activeTargets)
    });
});

// 2. Base64 QR code lene ka endpoint
app.get('/qr', (req, res) => {
    if (isConnected) {
        return res.json({ status: "connected", qr: null });
    }
    if (!currentQR) {
        return res.json({ status: "waiting", qr: null, message: "QR ban raha hai, 3 second baad reload karein." });
    }
    return res.json({ status: "ready", qr: currentQR });
});

app.get('/', (req, res) => {
    res.send("WhatsApp Bot Service Running!");
});

app.listen(PORT, () => {
    console.log(`Server port ${PORT} par active hai`);
});
