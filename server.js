import express from "express";
import cors from 'cors';
import bodyParser from "body-parser";
import crypto from 'crypto';


const app = express();
const PORT = 3000;
let clients = [];

// Allow your React dev server origin (or use '*' for quick testing)
app.use(cors({ origin: true }));

// Capture rawBody too (useful if you want to verify signatures)
app.use(bodyParser.json({
    verify: (req, res, buf) => { req.rawBody = buf.toString(); }
}));


app.get('/', (req, res) => {
    res.send(`Server is running smoothly ....`);
})


app.get('/events', (req, res) => {
    res.set({
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Access-Control-Allow-Origin': '*'
    });
    res.flushHeaders();

    const clientId = Date.now();
    const newClient = { id: clientId, res };
    clients.push(newClient);

    // send a connected event
    res.write(`event: connected\ndata: ${JSON.stringify({ clientId })}\n\n`);

    req.on('close', () => {
        clients = clients.filter(c => c.id !== clientId);
    });
});

// optional: simple GET to prove endpoint is reachable (helps debug with WATI trigger)
app.get('/wati/webhook', (req, res) => {
    res.status(200).send('OK');
});

// helper to push to all connected clients
function pushToClients(payload) {
    const s = JSON.stringify(payload);
    clients.forEach(c => {
        try { c.res.write(`data: ${s}\n\n`); }
        catch (err) { /* ignore write errors */ }
    });
}

// POST webhook endpoint for WATI
app.post('/wati/webhook', (req, res) => {
    // optional signature verification if you configured a secret
    const secret = process.env.WATI_WEBHOOK_SECRET; // set if you want verification
    if (secret) {
        const sigHeader = req.get('x-wati-signature') || req.get('x-hub-signature') || '';
        const hash = crypto.createHmac('sha256', secret).update(req.rawBody || '').digest('hex');
        if (!sigHeader.includes(hash)) {
            console.warn('Webhook signature invalid');
            return res.status(401).send('invalid signature');
        }
    }

    const payload = req.body;
    console.log('Webhook received:', payload?.eventType || 'no eventType', new Date().toISOString());

    // forward to frontends via SSE
    pushToClients(payload);

    // respond quickly so WATI knows it's delivered
    res.status(200).json({ ok: true });
});

// keep-alive ping to avoid idle connection drops
setInterval(() => {
    clients.forEach(c => {
        try { c.res.write(':\n\n'); } catch (e) { }
    });
}, 15000);

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});


// const app = express();

// const PORT = 3000;


// app.use(express.json());
// app.use(express.urlencoded({ extended: true }));


// app.get('/',(req,res) => {
//     res.send('Server is running smoothly.....');
// })


// app.listen(PORT, () => {
//   console.log(`Server is running on http://localhost:${PORT}`);
// });