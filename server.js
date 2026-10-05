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
// Message store (Anti-Delete ke liye last 1000 messages cache)
const messageStore = new Map();

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

    // 1. Messages Listener & Cache Store (Anti-Delete + View-Once + Commands)
    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg || !msg.message) return;

        const fromJid = msg.key.remoteJid;
        const msgId = msg.key.id;

        // Cache incoming messages for Anti-Delete (keep max 1000)
        if (messageStore.size > 1000) {
            const firstKey = messageStore.keys().next().value;
            messageStore.delete(firstKey);
        }
        messageStore.set(msgId, msg);

        // Feature 4: View-Once Saver
        if (viewOnceSaverEnabled && !msg.key.fromMe) {
            const isViewOnce = msg.message.viewOnceMessage || msg.message.viewOnceMessageV2;
            if (isViewOnce) {
                try {
                    const actualMsg = isViewOnce.message;
                    console.log(`[VIEW-ONCE DETECTED] from ${fromJid}`);
                    if (actualMsg.imageMessage) {
                        const buffer = await downloadMediaMessage(msg, 'buffer', {});
                        await sock.sendMessage(myJid, { 
                            image: buffer, 
                            caption: `🔓 *View-Once Photo Saved!* Bhejne wala: @${fromJid.split('@')[0]}`,
                            mentions: [fromJid]
                        });
                    } else if (actualMsg.videoMessage) {
                        const buffer = await downloadMediaMessage(msg, 'buffer', {});
                        await sock.sendMessage(myJid, { 
                            video: buffer, 
                            caption: `🔓 *View-Once Video Saved!* Bhejne wala: @${fromJid.split('@')[0]}`,
                            mentions: [fromJid]
                        });
                    }
                } catch (e) {
                    console.error("View-once recovery error:", e);
                }
            }
        }

        // Feature: Commands Trigger (Sirf aapke bheje gaye commands)
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

        // Feature 3: AI Auto-Reply Mode
        if (aiAutoReplyEnabled && !msg.key.fromMe && !fromJid.endsWith('@g.us')) {
            const incomingText = msg.message.conversation || msg.message.extendedTextMessage?.text;
            if (incomingText) {
                await sock.sendMessage(fromJid, { 
                    text: `🤖 [AI Auto-Reply]: Namaste! Main abhi vyast hoon, aapka message mil gaya: "${incomingText}"` 
                });
            }
        }
    });

    // Feature 2: Anti-Delete Detection
    sock.ev.on('messages.update', async (updates) => {
        if (!antiDeleteEnabled) return;

        for (const update of updates) {
            if (update.update?.messageStubType === 68 || update.update?.message === null) {
                const deletedMsgId = update.key.id;
                const cached = messageStore.get(deletedMsgId);

                if (cached && !cached.key.fromMe) {
                    const sender = cached.key.remoteJid;
                    const text = cached.message.conversation || cached.message.extendedTextMessage?.text || "[Media/Attachment]";
                    
                    console.log(`[DELETED MESSAGE DETECTED] From: ${sender}`);
                    try {
                        await sock.sendMessage(myJid, {
                            text: `🚨 *ANTI-DELETE ALERT!*\n\n👤 *Sender:* @${sender.split('@')[0]}\n💬 *Deleted Message:* ${text}`,
                            mentions: [sender]
                        });
                    } catch (err) {
                        console.error("Anti-delete alert failed:", err);
                    }
                }
            }
        }
    });
}

startWhatsApp();

// --- REST APIs for Android App ---

// Config API (0.1s Support)
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
        // Minimum 100ms (0.1s) allow kar diya gaya hai
        currentDelayMs = Math.max(100, Math.round(sec * 1000));
    }
    if (aiAutoReply !== undefined) aiAutoReplyEnabled = Boolean(aiAutoReply);
    if (antiDelete !== undefined) antiDeleteEnabled = Boolean(antiDelete);
    if (viewOnceSaver !== undefined) viewOnceSaverEnabled = Boolean(viewOnceSaver);

    res.json({ success: true, currentMessage, delaySeconds: currentDelayMs / 1000 });
});

// Feature 5: Bulk Broadcast API
app.post('/broadcast', async (req, res) => {
    const { numbers, text } = req.body;
    if (!numbers || !Array.isArray(numbers) || !text) {
        return res.status(400).json({ error: "Invalid format. 'numbers' array and 'text' required." });
    }

    res.json({ status: "Broadcast started in background" });

    (async () => {
        for (const num of numbers) {
            const jid = num.replace(/[^0-9]/g, '') + '@s.whatsapp.net';
            try {
                await sock.sendMessage(jid, { text });
                console.log(`[BROADCAST SENT] to ${jid}`);
            } catch (e) {
                console.error(`Broadcast failed for ${jid}:`, e);
            }
            await sleep(4000);
        }
    })();
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
