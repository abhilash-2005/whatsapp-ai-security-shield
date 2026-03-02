require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');

const app = express();
app.use(bodyParser.json());

const PORT = 3000;

// 🔹 Verification endpoint (Meta uses this to verify webhook)
app.get('/webhook', (req, res) => {
    const VERIFY_TOKEN = process.env.VERIFY_TOKEN;

    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode && token) {
        if (mode === 'subscribe' && token === VERIFY_TOKEN) {
            console.log("Webhook verified successfully!");
            return res.status(200).send(challenge);
        } else {
            return res.sendStatus(403);
        }
    }
});

// 🔹 Receive messages from WhatsApp
const axios = require('axios');

app.post('/webhook', async (req, res) => {
    try {
        const entry = req.body.entry?.[0];
        const change = entry?.changes?.[0];
        const message = change?.value?.messages?.[0];

        if (message && message.type === "text") {
            const from = message.from;
            const text = message.text.body;

            console.log("Message from:", from);
            console.log("Text:", text);

            // 🔍 Simple Security Check
            let reply = "Message received.";

            if (text.toLowerCase().includes("otp") || text.toLowerCase().includes("bank")) {
                reply = "⚠️ Security Alert: This message may contain scam or phishing content. Do NOT share OTP or bank details.";
            }

            await axios.post(
                `https://graph.facebook.com/v19.0/${process.env.PHONE_NUMBER_ID}/messages`,
                {
                    messaging_product: "whatsapp",
                    to: from,
                    text: { body: reply }
                },
                {
                    headers: {
                        Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
                        "Content-Type": "application/json"
                    }
                }
            );

            console.log("Reply sent successfully.");
        }

        res.sendStatus(200);
    } catch (error) {
        console.error("Error:", error.response?.data || error.message);
        res.sendStatus(500);
    }
});

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});