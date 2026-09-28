import express from 'express';
import cors from 'cors';
import 'dotenv/config';
import makeWASocket, { DisconnectReason } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import qrcode from 'qrcode';
import { Pool } from 'pg';
import { usePostgresAuthState } from './usePostgresAuthState';
import pino from 'pino';

const app = express();
app.use(cors());
app.use(express.json());

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const sessions: { [id: string]: { sock: ReturnType<typeof makeWASocket>, qr?: string, status: string } } = {};

async function clearSessionCreds(sessionId: string) {
    try { await pool.query('DELETE FROM "WhatsAppSession" WHERE id LIKE $1', [`${sessionId}%`]); } catch {}
}

async function startSock(sessionId: string) {
    const { state, saveCreds } = await usePostgresAuthState(pool, sessionId);
    const sock = makeWASocket({ auth: state, printQRInTerminal: true, logger: pino({ level: 'silent' }) });
    sessions[sessionId] = { sock, status: 'connecting' };
    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) { sessions[sessionId].qr = qr; sessions[sessionId].status = 'qr'; }
        if (connection === 'close') {
            const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
            if (statusCode === DisconnectReason.loggedOut || statusCode === 401) {
                sessions[sessionId].status = 'restarting';
                await clearSessionCreds(sessionId);
                delete sessions[sessionId];
                setTimeout(() => startSock(sessionId), 2000);
            } else {
                sessions[sessionId].status = 'disconnected';
                setTimeout(() => startSock(sessionId), 3000);
            }
        } else if (connection === 'open') {
            sessions[sessionId].status = 'connected';
            sessions[sessionId].qr = undefined;
        }
    });
}

app.get('/', (req, res) => res.send({ status: 'Server is running', sessions: Object.keys(sessions).map(k => ({ id: k, status: sessions[k].status })) }));

app.post('/api/start', async (req, res) => {
    const { sessionId } = req.body;
    if (!sessionId) return res.status(400).send({ error: 'sessionId required' });
    if (!sessions[sessionId] || sessions[sessionId].status === 'disconnected') await startSock(sessionId);
    res.send({ status: sessions[sessionId]?.status || 'starting', sessionId });
});

app.post('/api/reset/:sessionId', async (req, res) => {
    const { sessionId } = req.params;
    if (sessions[sessionId]) { try { sessions[sessionId].sock.logout(); } catch {} delete sessions[sessionId]; }
    await clearSessionCreds(sessionId);
    await startSock(sessionId);
    res.send({ ok: true });
});

app.get('/api/qr/:sessionId', async (req, res) => {
    const { sessionId } = req.params;
    const session = sessions[sessionId];
    if (!session) return res.status(404).send({ status: 'not_found' });
    if (session.status === 'connected') return res.send({ status: 'connected', qr: null });
    if (session.qr) { const url = await qrcode.toDataURL(session.qr); return res.send({ status: 'qr', qr: url }); }
    res.send({ status: session.status, qr: null });
});

app.post('/api/send', async (req, res) => {
    const { sessionId, phone, message } = req.body;
    if (!sessionId || !phone || !message) return res.status(400).send({ error: 'Missing params' });
    const session = sessions[sessionId];
    if (!session || session.status !== 'connected') return res.status(400).send({ error: 'Session not connected' });
    try {
        await session.sock.sendMessage(`${phone.replace(/\D/g, '')}@s.whatsapp.net`, { text: message });
        res.send({ ok: true });
    } catch (e: any) { res.status(500).send({ ok: false, error: e.message }); }
});

app.listen(process.env.PORT || 3001, () => console.log(`WhatsApp Server running on port ${process.env.PORT || 3001}`));
