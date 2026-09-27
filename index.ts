import express from 'express';
import cors from 'cors';
import 'dotenv/config';
import makeWASocket, { DisconnectReason, useMultiFileAuthState } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import qrcode from 'qrcode';
import { Pool } from 'pg';
import { usePostgresAuthState } from './usePostgresAuthState';
import pino from 'pino';

const app = express();
app.use(cors());
app.use(express.json());

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
    console.error("Missing DATABASE_URL");
    process.exit(1);
}

const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

const sessions: { [id: string]: { sock: ReturnType<typeof makeWASocket>, qr?: string, status: string } } = {};

async function startSock(sessionId: string) {
    const { state, saveCreds } = await usePostgresAuthState(pool, sessionId);
    
    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: true,
        logger: pino({ level: 'silent' }), // Reduce noise
    });

    sessions[sessionId] = { sock, status: 'connecting' };

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            sessions[sessionId].qr = qr;
            sessions[sessionId].status = 'qr';
            console.log(`QR Code generated for session ${sessionId}`);
        }

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect?.error as Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
            sessions[sessionId].status = 'disconnected';
            console.log(`Connection closed for ${sessionId} due to`, lastDisconnect?.error, `, reconnecting:`, shouldReconnect);
            
            if (shouldReconnect) {
                startSock(sessionId);
            } else {
                sessions[sessionId].status = 'logged_out';
            }
        } else if (connection === 'open') {
            sessions[sessionId].status = 'connected';
            sessions[sessionId].qr = undefined;
            console.log(`Connection opened for ${sessionId}`);
        }
    });

    return sock;
}

// Start existing sessions if needed (you can load from DB or just wait for them to be requested)
// For now, we'll initialize them when requested

app.get('/', (req, res) => {
    res.send({ status: 'Server is running', sessions: Object.keys(sessions).map(k => ({ id: k, status: sessions[k].status })) });
});

app.post('/api/start', async (req, res) => {
    const { sessionId } = req.body;
    if (!sessionId) return res.status(400).send({ error: 'sessionId required' });

    if (!sessions[sessionId] || sessions[sessionId].status === 'disconnected' || sessions[sessionId].status === 'logged_out') {
        await startSock(sessionId);
    }
    res.send({ status: 'started', sessionId });
});

app.get('/api/qr/:sessionId', async (req, res) => {
    const { sessionId } = req.params;
    const session = sessions[sessionId];
    if (!session) return res.status(404).send({ error: 'Session not found. Call /api/start first.' });

    if (session.status === 'connected') {
        return res.send({ status: 'connected', qr: null });
    }

    if (session.qr) {
        const url = await qrcode.toDataURL(session.qr);
        return res.send({ status: 'qr', qr: url, raw: session.qr });
    }

    res.send({ status: session.status, qr: null });
});

app.post('/api/send', async (req, res) => {
    const { sessionId, phone, message } = req.body;
    if (!sessionId || !phone || !message) return res.status(400).send({ error: 'Missing params' });

    const session = sessions[sessionId];
    if (!session || session.status !== 'connected') {
        return res.status(400).send({ error: 'Session not connected' });
    }

    try {
        const jid = `${phone.replace(/\D/g, '')}@s.whatsapp.net`;
        await session.sock.sendMessage(jid, { text: message });
        res.send({ ok: true });
    } catch (e: any) {
        res.status(500).send({ ok: false, error: e.message });
    }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
    console.log(`WhatsApp Server is running on port ${PORT}`);
});
