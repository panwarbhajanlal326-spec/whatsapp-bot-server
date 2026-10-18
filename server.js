import express from 'express';
import makeWASocket, { 
    DisconnectReason, 
    useMultiFileAuthState, 
    Browsers 
} from '@whiskeysockets/baileys';
import pino from 'pino';
import QRCode from 'qrcode';
import axios from 'axios';
import fs from 'fs';
import path from 'path';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// --- GROQ AI CONFIGURATION ---
const GROQ_API_KEY = process.env.GROQ_API_KEY || "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";
const AI_MODEL = "openai/gpt-oss-120b";

// --- SMART AI REPLY FUNCTION (AXIOS ENGINE) ---
async function getAIReply(userText) {
    try {
        const response = await axios.post(
            "https://api.groq.com/openai/v1/chat/completions",
            {
                model: AI_MODEL,
                messages: [
                    {
                        role: "system",
                        content: `Aap WhatsApp par ek friendly, respectful Indian assistant ho. 
User jis bhasha aur script me bole (Hinglish, Hindi, Desi, English), usi me 1-2 line me direct WhatsApp style reply do. Faltu options ya AI mat bolo.`
                    },
                    {
                        role: "user",
                        content: userText
                    }
                ]
            },
            {
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${GROQ_API_KEY}`
                },
                timeout: 10000
            }
        );

        if (response.data?.choices?.[0]?.message?.content) {
            return response.data.choices[0].message.content.trim();
        }
        return null;
    } catch (err) {
        console.error("❌ [Groq AI Error]:", err.response?.data || err.message);
        return null;
    }
}

// Multi-Session Memory Store
const sessions = new Map();

function getOrCreateUserSession(userId) {
    if (!sessions.has(userId)) {
        sessions.set(userId, {
            sock: null,
            qr: null,
            isConnected: false,
            myJid: null,
            settings: {
                message: "Automated reply: System generated.",
                delayMs: 3000,
                aiAutoReply: true, // Default ON
                antiDelete: true
            },
            activeTargets: new Set(),
            messageStore: new Map(),
            deletedLogs: []
        });
    }
    return sessions.get(userId);
}

async function startWhatsAppForUser(userId) {
    const userSession = getOrCreateUserSession(userId);
    const sessionDir = path.join('auth_sessions', userId);

    if (!fs.existsSync(sessionDir)) {
        fs.mkdirSync(sessionDir, { recursive: true });
    }

    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        browser: Browsers.ubuntu('Chrome'),
        syncFullHistory: false
    });

    userSession.sock = sock;

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            try {
                userSession.qr = await QRCode.toDataURL(qr);
                console.log(`[QR Ready] User: ${userId}`);
            } catch (err) {
                console.error(`[QR Error] User: ${userId}`, err);
            }
        }

        if (connection === 'close') {
            userSession.isConnected = false;
            userSession.qr = null;
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            console.log(`[Session Closed] User: ${userId}, Code: ${statusCode}, Reconnect: ${shouldReconnect}`);
            if (shouldReconnect) {
                startWhatsAppForUser(userId);
            }
        } else if (connection === 'open') {
            userSession.isConnected = true;
            userSession.qr = null;
            userSession.myJid = sock.user.id.split(':')[0] + '@s.whatsapp.net';
            console.log(`✅ [Connected] User: ${userId} as ${userSession.myJid}`);
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg || !msg.message) return;

        const fromJid = msg.key.remoteJid;
        const msgId = msg.key.id;

        // Message store cache
        if (userSession.messageStore.size > 1500) {
            const firstKey = userSession.messageStore.keys().next().value;
            userSession.messageStore.delete(firstKey);
        }
        userSession.messageStore.set(msgId, msg);

        // Loop commands (z = start, x/stop = end)
        if (msg.key.fromMe) {
            const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
            const cleanText = text.toLowerCase().trim();

            if (cleanText === 'stop' || cleanText === 'x') {
                if (userSession.activeTargets.has(fromJid)) {
                    userSession.activeTargets.delete(fromJid);
                    await sock.sendMessage(fromJid, { text: "🛑 Loop stopped." });
                }
                return;
            }

            if (cleanText === 'z') {
                if (!userSession.activeTargets.has(fromJid)) {
                    userSession.activeTargets.add(fromJid);
                    (async () => {
                        while (userSession.activeTargets.has(fromJid) && userSession.isConnected) {
                            try {
                                await sock.sendMessage(fromJid, { text: userSession.settings.message });
                            } catch (err) {
                                userSession.activeTargets.delete(fromJid);
                                break;
                            }
                            await sleep(userSession.settings.delayMs);
                        }
                    })();
                }
                return;
            }
        }

        // --- SMART AI AUTO-REPLY ---
        if (!msg.key.fromMe && !fromJid.endsWith('@g.us')) {
            const incomingText = msg.message.conversation || msg.message.extendedTextMessage?.text;
            
            if (incomingText && userSession.settings.aiAutoReply) {
                console.log(`📩 [Msg Received]: "${incomingText}" from ${fromJid}`);

                const aiResponse = await getAIReply(incomingText);
                if (aiResponse) {
                    await sock.sendPresenceUpdate('composing', fromJid);
                    await sleep(600);
                    await sock.sendMessage(fromJid, { text: aiResponse });
                    console.log(`🤖 [AI Replied]: "${aiResponse}"`);
                }
            }
        }
    });

    // Anti-Delete Listener
    sock.ev.on('messages.update', async (updates) => {
        if (!userSession.settings.antiDelete) return;

        for (const update of updates) {
            const isRevoked = update.update?.messageStubType === 68 || 
                              update.update?.message === null || 
                              update.update?.protocolMessage?.type === 0;

            if (isRevoked) {
                const deletedMsgId = update.key.id;
                const cached = userSession.messageStore.get(deletedMsgId);

                if (cached && !cached.key.fromMe) {
                    const sender = cached.key.remoteJid.split('@')[0];
                    const text = cached.message.conversation || 
                                 cached.message.extendedTextMessage?.text || 
                                 "[Media File ya Sticker]";

                    console.log(`[DELETED] User: ${userId} | Sender: ${sender} | Text: ${text}`);

                    userSession.deletedLogs.unshift({
                        id: deletedMsgId,
                        sender: sender,
                        text: text
                    });

                    if (userSession.deletedLogs.length > 60) {
                        userSession.deletedLogs.pop();
                    }
                }
            }
        }
    });
}

// --- REST APIs ---

app.get('/qr', async (req, res) => {
    const userId = req.query.userId;
    if (!userId) return res.status(400).json({ error: "userId parameter required" });

    const userSession = getOrCreateUserSession(userId);

    if (userSession.isConnected) {
        return res.json({ status: "connected", qr: null });
    }

    if (!userSession.sock) {
        startWhatsAppForUser(userId);
        return res.json({ status: "waiting", message: "Session starting, try again in 3 seconds..." });
    }

    if (!userSession.qr) {
        return res.json({ status: "waiting", message: "Generating QR code..." });
    }

    return res.json({ status: "ready", qr: userSession.qr });
});

app.get('/status', (req, res) => {
    const userId = req.query.userId;
    if (!userId) return res.status(400).json({ error: "userId parameter required" });

    const userSession = getOrCreateUserSession(userId);
    return res.json({ 
        connected: userSession.isConnected, 
        activeChats: Array.from(userSession.activeTargets) 
    });
});

app.get('/config', (req, res) => {
    const userId = req.query.userId;
    if (!userId) return res.status(400).json({ error: "userId parameter required" });

    const userSession = getOrCreateUserSession(userId);
    res.json({
        message: userSession.settings.message,
        delaySeconds: userSession.settings.delayMs / 1000,
        aiAutoReply: userSession.settings.aiAutoReply,
        antiDelete: userSession.settings.antiDelete
    });
});

app.post('/config', (req, res) => {
    const { userId, message, delaySeconds, aiAutoReply, antiDelete } = req.body;
    if (!userId) return res.status(400).json({ error: "userId parameter required" });

    const userSession = getOrCreateUserSession(userId);

    if (message !== undefined) userSession.settings.message = message.trim();
    if (delaySeconds !== undefined) {
        let sec = parseFloat(delaySeconds);
        userSession.settings.delayMs = Math.max(100, Math.round(sec * 1000));
    }
    if (aiAutoReply !== undefined) userSession.settings.aiAutoReply = Boolean(aiAutoReply);
    if (antiDelete !== undefined) userSession.settings.antiDelete = Boolean(antiDelete);

    res.json({ 
        success: true, 
        currentMessage: userSession.settings.message, 
        delaySeconds: userSession.settings.delayMs / 1000 
    });
});

app.get('/deleted-logs', (req, res) => {
    const userId = req.query.userId;
    if (!userId) return res.status(400).json({ error: "userId parameter required" });

    const userSession = getOrCreateUserSession(userId);
    res.json(userSession.deletedLogs);
});

app.get('/', (req, res) => res.send("Bhajanlal Multi-User Automation Backend Live!"));

app.listen(PORT, () => console.log(`Engine Live on port ${PORT}`));
