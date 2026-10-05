import express from 'express';
import makeWASocket, { 
    DisconnectReason, 
    useMultiFileAuthState, 
    Browsers, 
    downloadMediaMessage 
} from '@whiskeysockets/baileys';
import pino from 'pino';
import QRCode from 'qrcode';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let sock = null;
let currentQR = null;
let isConnected = false;
let myJid = null;

// Dynamic Settings (App se control)
let currentMessage = "Automated reply: Yeh system generated message hai.";
let currentDelayMs = 3000;
let aiAutoReplyEnabled = false;
let antiDeleteEnabled = true;
let viewOnceSaverEnabled = true;

// Active spam/loop targets
const activeTargets = new Set();
// Message store (Anti-Delete ke liye last 2000 messages cache)
const messageStore = new Map();
// Deleted messages store (Android App logs ke liye)
const deletedLogs = [];

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
            console.log(`Connection closed (code: ${statusCode}). Reconnecting: ${shouldReconnect}`);
            if (shouldReconnect) startWhatsApp();
        } else if (connection === 'open') {
            isConnected = true;
            currentQR = null;
            myJid = sock.user.id.split(':')[0] + '@s.whatsapp.net';
            console.log(`✅ WhatsApp Connected! Logged in as: ${myJid}`);
        }
    });

    // Messages Listener & Cache Store
    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg || !msg.message) return;

        const fromJid = msg.key.remoteJid;
        const msgId = msg.key.id;

        // Cache messages for Anti-Delete
        if (messageStore.size > 2000) {
            const firstKey = messageStore.keys().next().value;
            messageStore.delete(firstKey);
        }
        messageStore.set(msgId, msg);

        // Feature: View-Once Saver
        if (viewOnceSaverEnabled && !msg.key.fromMe) {
            const isViewOnce = msg.message.viewOnceMessage || msg.message.viewOnceMessageV2;
            if (isViewOnce) {
                try {
                    const actualMsg = isViewOnce.message;
                    if (actualMsg.imageMessage) {
                        const buffer = await downloadMediaMessage(msg, 'buffer', {});
                        await sock.sendMessage(fromJid, { 
                            image: buffer, 
                            caption: `🔓 *View-Once Photo Recovered!*`
                        }, { quoted: msg });
                    } else if (actualMsg.videoMessage) {
                        const buffer = await downloadMediaMessage(msg, 'buffer', {});
                        await sock.sendMessage(fromJid, { 
                            video: buffer, 
                            caption: `🔓 *View-Once Video Recovered!*`
                        }, { quoted: msg });
                    }
                } catch (e) {
                    console.error("View-once recovery error:", e);
                }
            }
        }

        // Remote Commands (x and z)
        if (msg.key.fromMe) {
            const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
            const cleanText = text.toLowerCase().trim();

            if (cleanText === 'stop' || cleanText === 'x') {
                if (activeTargets.has(fromJid)) {
                    activeTargets.delete(fromJid);
                    await sock.sendMessage(fromJid, { text: "🛑 Loop stopped." });
                }
                return;
            }

            if (cleanText === 'z') {
                if (!activeTargets.has(fromJid)) {
                    activeTargets.add(fromJid);
                    (async () => {
                        while (activeTargets.has(fromJid) && isConnected) {
                            try {
                                await sock.sendMessage(fromJid, { text: currentMessage });
                            } catch (err) {
                                activeTargets.delete(fromJid);
                                break;
                            }
                            await sleep(currentDelayMs);
                        }
                    })();
                }
                return;
            }
        }

        // AI Auto Reply
        if (aiAutoReplyEnabled && !msg.key.fromMe && !fromJid.endsWith('@g.us')) {
            const incomingText = msg.message.conversation || msg.message.extendedTextMessage?.text;
            if (incomingText) {
                await sock.sendMessage(fromJid, { 
                    text: `🤖 [Auto-Reply]: Namaste! Main abhi vyast hoon, aapka message mil gaya: "${incomingText}"` 
                });
            }
        }
    });

    // Anti-Delete (Samne wale ko koi sms nahi jayega, sirf app ke logs mein save hoga)
    sock.ev.on('messages.update', async (updates) => {
        if (!antiDeleteEnabled) return;

        for (const update of updates) {
            const isRevoked = update.update?.messageStubType === 68 || 
                              update.update?.message === null || 
                              update.update?.protocolMessage?.type === 0;

            if (isRevoked) {
                const deletedMsgId = update.key.id;
                const cached = messageStore.get(deletedMsgId);

                if (cached && !cached.key.fromMe) {
                    const sender = cached.key.remoteJid.split('@')[0];
                    const text = cached.message.conversation || 
                                 cached.message.extendedTextMessage?.text || 
                                 "[Media / Photo / Audio]";

                    console.log(`[DELETED DETECTED] From: ${sender}, Text: ${text}`);

                    deletedLogs.unshift({
                        id: deletedMsgId,
                        sender: sender,
                        text: text
                    });

                    if (deletedLogs.length > 50) deletedLogs.pop();
                }
            }
        }
    });
}

startWhatsApp();

// --- REST APIs ---

app.get('/config', (req, res) => {
    res.json({
        message: currentMessage,
        delaySeconds: currentDelayMs / 1000,
        aiAutoReply: aiAutoReplyEnabled,
        antiDelete: antiDeleteEnabled,
        viewOnceSaver: viewOnceSaverEnabled
    });
});

app.post('/config', (req, res) => {
    const { message, delaySeconds, aiAutoReply, antiDelete, viewOnceSaver } = req.body;
    if (message !== undefined) currentMessage = message.trim();
    if (delaySeconds !== undefined) {
        let sec = parseFloat(delaySeconds);
        currentDelayMs = Math.max(100, Math.round(sec * 1000));
    }
    if (aiAutoReply !== undefined) aiAutoReplyEnabled = Boolean(aiAutoReply);
    if (antiDelete !== undefined) antiDeleteEnabled = Boolean(antiDelete);
    if (viewOnceSaver !== undefined) viewOnceSaverEnabled = Boolean(viewOnceSaver);

    res.json({ success: true, currentMessage, delaySeconds: currentDelayMs / 1000 });
});

app.get('/deleted-logs', (req, res) => {
    res.json(deletedLogs);
});

app.get('/status', (req, res) => {
    res.json({ connected: isConnected, activeChats: Array.from(activeTargets) });
});

app.get('/qr', (req, res) => {
    if (isConnected) return res.json({ status: "connected", qr: null });
    if (!currentQR) return res.json({ status: "waiting", qr: null });
    return res.json({ status: "ready", qr: currentQR });
});

app.get('/', (req, res) => res.send("Panwar Mega WhatsApp Automation Active!"));

app.listen(PORT, () => console.log(`Server live on port ${PORT}`));
