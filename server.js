import express from "express";
import cors from 'cors';
import bodyParser from "body-parser";
import crypto from 'crypto';
import session from "cookie-session"
import { google } from "googleapis";
import dotenv from 'dotenv';

const app = express();
const PORT = 3000;
let clients = [];

dotenv.config();

// Allow your React dev server origin (or use '*' for quick testing)
app.use(cors({
    origin: "http://localhost:5173",
    credentials: true
}));
// Capture rawBody too (useful if you want to verify signatures)
app.use(bodyParser.json({
    verify: (req, res, buf) => { req.rawBody = buf.toString(); }
}));


//////////////////////////////Code for Email ////////////////////////////
// The below code written for the implementation of Email authentication in the backend....


console.log(process.env.GOOGLE_CLIENT_ID, '', process.env.GOOGLE_CLIENT_SECRET, '', process.env.GOOGLE_REDIRECT_URI, '', process.env.SESSION_SECRET);


app.use(session({
    name: 'session',
    keys: [process.env.SESSION_SECRET],
    // maxAge: 24 * 60 * 60 * 1000 // 24 hours
}))

const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
);


// app.get("/auth", (req, res) => {
//     const url = oauth2Client.generateAuthUrl({
//         access_type: "offline",
//         scope: ["https://www.googleapis.com/auth/gmail.readonly"],
//         prompt: "consent",
//     });
//     res.redirect(url);
// });


app.get('/auth', (req, res) => {
    const googleAuthUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${process.env.GOOGLE_CLIENT_ID}&redirect_uri=${process.env.GOOGLE_REDIRECT_URI}&response_type=code&scope=openid%20email%20profile%20https://www.googleapis.com/auth/gmail.readonly&access_type=offline&prompt=consent`;
    res.redirect(googleAuthUrl);
});


app.get("/auth/callback", async (req, res) => {
    const { code } = req.query;
    const { tokens } = await oauth2Client.getToken(code);
    req.session.tokens = tokens; // Store access & refresh tokens in session
    oauth2Client.setCredentials(tokens);
    res.redirect("http://localhost:5173"); // Redirect to frontend
});

const ensureAuth = (req, res, next) => {
    if (!req.session.tokens) return res.status(401).json({ error: "Unauthorized" });
    oauth2Client.setCredentials(req.session.tokens);
    next();
};

// app.get("/gmail/messages", ensureAuth, async (req, res) => {
//     // console.log(result,'This is the result okay.....')
//     try {
//         const gmail = google.gmail({ version: "v1", auth: oauth2Client });
//         const result = await gmail.users.messages.list({
//             userId: "me",
//             maxResults: 10,
//         });
//         console.log(result.data.messages,'This is the result . . . . ');
//         res.json(result.data.messages || []);
//     } catch (err) {
//         res.status(500).json({ error: err.message });
//     }
// });


app.get("/gmail/messages", ensureAuth, async (req, res) => {
    try {
        const gmail = google.gmail({ version: "v1", auth: oauth2Client });
        const listResponse = await gmail.users.messages.list({
            userId: "me",
            maxResults: 3,
        });

        const messages = listResponse.data.messages || [];
        const detailedMessages = await Promise.all(
            messages.map(async (msg) => {
                const msgDetail = await gmail.users.messages.get({
                    userId: "me",
                    id: msg.id,
                });

                return {
                    id: msg.id,
                    threadId: msg.threadId,
                    payload: msgDetail.data.payload,
                    snippet: msgDetail.data.snippet,
                };
            })
        );

        console.log(detailedMessages);

        res.json(detailedMessages);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


app.post("/gmail/messages/:id/star", ensureAuth, async (req, res) => {
    try {
        const gmail = google.gmail({ version: "v1", auth: oauth2Client });
        await gmail.users.messages.modify({
            userId: "me",
            id: req.params.id,
            resource: { addLabelIds: ["STARRED"] },
        });
        res.json({ message: "Starred" });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post("/gmail/messages/:id/read", ensureAuth, async (req, res) => {
    try {
        const gmail = google.gmail({ version: "v1", auth: oauth2Client });
        await gmail.users.messages.modify({
            userId: "me",
            id: req.params.id,
            resource: { removeLabelIds: ["UNREAD"] },
        });
        res.json({ message: "Marked as Read" });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


/////////////////////////////////////////////////////////////////////////

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
