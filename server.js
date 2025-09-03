import express from "express";
import cors from 'cors';
import bodyParser from "body-parser";
import crypto from 'crypto';
import session from "cookie-session"
import { google } from "googleapis";
import dotenv from 'dotenv';
import { decode } from "js-base64";

const app = express();
const PORT = 3000;
let clients = [];

dotenv.config();

app.use(cors({
    origin: "http://localhost:5173",
    // origin:'*',
    credentials: true
}));


app.use(bodyParser.json({
    verify: (req, res, buf) => { req.rawBody = buf.toString(); }
}));


// ---------------- Email Authentication ----------------

// The below code written for the implementation of Email authentication in the backend....


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

const gmail = google.gmail({ version: 'v1', auth: oauth2Client });


function pushToClients(payload) {
    const s = JSON.stringify(payload);
    clients.forEach(c => {
        try { c.res.write(`data: ${s}\n\n`); }
        catch (err) { /* ignore write errors */ }
    });
}

app.get('/auth', (req, res) => {
    const googleAuthUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${process.env.GOOGLE_CLIENT_ID}&redirect_uri=${process.env.GOOGLE_REDIRECT_URI}&response_type=code&scope=openid%20email%20profile%20https://www.googleapis.com/auth/gmail.readonly&access_type=offline&prompt=consent`;
    res.redirect(googleAuthUrl);
});


app.get("/auth/callback", async (req, res) => {
    const { code } = req.query;
    const { tokens } = await oauth2Client.getToken(code);

    req.session.tokens = tokens;
    oauth2Client.setCredentials(tokens);

    const gmail = google.gmail({ version: "v1", auth: oauth2Client });
    await gmail.users.watch({
        userId: 'me',
        requestBody: {
            topicName: 'projects/certain-purpose-446711-b6/topics/myfirstproject',
            labelIds: ['INBOX'],
            labelFilterBehavior: 'INCLUDE',
        }
    });

    res.redirect("http://localhost:5173");
});

const ensureAuth = (req, res, next) => {
    if (!req.session.tokens) return res.status(401).json({ error: "Unauthorized" });
    oauth2Client.setCredentials(req.session.tokens);
    next();
};


function getBody(payload) {
    let body = "";

    // If message has multiple parts
    if (payload.parts) {
        for (const part of payload.parts) {
            // Prefer HTML
            if (part.mimeType === "text/html" && part.body?.data) {
                return decode(part.body.data.replace(/-/g, "+").replace(/_/g, "/"));
            }

            // Keep searching in nested parts
            if (part.parts) {
                const nestedBody = getBody(part);
                if (nestedBody) return nestedBody;
            }
        }
    }

    // Fallback → plain text
    if (payload.mimeType === "text/html" && payload.body?.data) {
        body = decode(payload.body.data.replace(/-/g, "+").replace(/_/g, "/"));
    } else if (payload.body?.data) {
        body = decode(payload.body.data.replace(/-/g, "+").replace(/_/g, "/"));
    }

    return body;
}


app.get("/gmail/messages", ensureAuth, async (req, res) => {
    try {
        const gmail = google.gmail({ version: "v1", auth: oauth2Client });

        // fetch list of messages
        const listResponse = await gmail.users.messages.list({
            userId: "me",
            maxResults: 10, // adjust as needed
        });

        const messages = listResponse.data.messages || [];

        const detailedMessages = await Promise.all(
            messages.map(async (msg) => {
                const msgDetail = await gmail.users.messages.get({
                    userId: "me",
                    id: msg.id,
                });

                const payload = msgDetail.data.payload;
                const headers = payload.headers;

                const subject =
                    headers.find((h) => h.name === "Subject")?.value || "(No Subject)";
                const from =
                    headers.find((h) => h.name === "From")?.value || "Unknown Sender";
                const date =
                    headers.find((h) => h.name === "Date")?.value ||
                    new Date().toISOString();

                // Extract body (HTML preferred, plain text fallback)
                const body = getBody(payload);

                return {
                    id: msg.id,
                    sender: from,
                    subject: subject,
                    preview: msgDetail.data.snippet,
                    body: body,
                    time: new Date(date).toLocaleString("en-US", {
                        month: "short",
                        day: "numeric",
                        year: "numeric",
                        hour: "numeric",
                        minute: "numeric",
                    }),
                    read: msgDetail.data.labelIds
                        ? !msgDetail.data.labelIds.includes("UNREAD")
                        : true,
                };
            })
        );

        res.json(detailedMessages);
    } catch (err) {
        console.error(err);
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

app.post('/gmail/webhook', (req, res) => {

    const msg = req.body.message;
    if (!msg || !msg.data) return res.sendStatus(400);

    const decoded = Buffer.from(msg.data, 'base64').toString();
    const payload = JSON.parse(decoded);

    console.log('📩 Gmail Webhook received:', new Date().toISOString(), payload);

    pushToClients({
        type: 'NEW_EMAIL',
        data: payload,
    });

    res.status(200).json({ ok: true });
});

// ------------------------------ End ------------------------------ 

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


app.get('/wati/webhook', (req, res) => {
    res.status(200).send('OK');
});


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

    pushToClients({
        type: 'NEW_WATI',
        data: payload,
    });

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













// ----------------- Old Working Code , for reference ------------------


// app.get("/auth/callback", async (req, res) => {
//     const { code } = req.query;
//     const { tokens } = await oauth2Client.getToken(code);
//     req.session.tokens = tokens; // Store access & refresh tokens in session
//     oauth2Client.setCredentials(tokens);
//     res.redirect("http://localhost:5173"); // Redirect to frontend
// });

