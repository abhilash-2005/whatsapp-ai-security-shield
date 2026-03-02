require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const fs = require('fs');
const fsExtra = require('fs-extra');
const path = require('path');
const { exec } = require('child_process');

const app = express();
app.use(bodyParser.json());

const PORT = 3000;
const logFilePath = path.join(__dirname, 'attack_logs.json');
const processedMessages = new Set();


// ===============================
// AI ANALYSIS FUNCTION
// ===============================
async function analyzeWithAI(messageText) {
    try {
        const response = await axios.post('http://localhost:11434/api/generate', {
            model: 'phi3',
            prompt: `
You are a cybersecurity AI.

Return ONLY valid JSON:

{
  "risk_score": number (0-100),
  "category": "safe | phishing | scam | fraud",
  "reason": "short explanation",
  "recommendation": "short advice"
}

Message:
${messageText}
`,
            format: "json",
            stream: false
        });

        return response.data.response;
    } catch (error) {
        console.error("AI Error:", error.message);
        return null;
    }
}


// ===============================
// OCR FUNCTION
// ===============================
async function extractTextFromImage(imagePath) {
    return new Promise((resolve, reject) => {
        const command = `"C:\\Program Files\\Tesseract-OCR\\tesseract.exe" "${imagePath}" stdout`;

        exec(command, (error, stdout) => {
            if (error) reject(error);
            else resolve(stdout);
        });
    });
}


// ===============================
// AUDIO TRANSCRIPTION (FFMPEG + WHISPER)
// ===============================
async function transcribeAudio(audioPath) {
    return new Promise((resolve, reject) => {

        const wavPath = audioPath.replace(".ogg", ".wav");

        // Convert OGG → WAV
        const convertCommand = `ffmpeg -y -i "${audioPath}" "${wavPath}"`;

        exec(convertCommand, (convertError) => {
            if (convertError) {
                console.error("FFmpeg Error:", convertError.message);
                return reject(convertError);
            }

            // Run Whisper
            const whisperCommand = `python -m whisper "${wavPath}" --model small --language en --fp16 False`;

            exec(whisperCommand, { maxBuffer: 1024 * 1024 * 10 }, (error, stdout) => {
                if (error) {
                    console.error("Whisper Error:", error.message);
                    return reject(error);
                }

                const lines = stdout.split("\n").filter(l => l.trim() !== "");

                if (lines.length > 0) {
                    const transcript = lines[lines.length - 1];
                    resolve(transcript);
                } else {
                    reject("Transcript extraction failed.");
                }

                // Cleanup WAV
                if (fs.existsSync(wavPath)) fs.unlinkSync(wavPath);
            });
        });
    });
}


// ===============================
// WEBHOOK VERIFICATION
// ===============================
app.get('/webhook', (req, res) => {
    if (
        req.query['hub.mode'] === 'subscribe' &&
        req.query['hub.verify_token'] === process.env.VERIFY_TOKEN
    ) {
        console.log("Webhook verified successfully!");
        return res.status(200).send(req.query['hub.challenge']);
    }

    res.sendStatus(403);
});


// ===============================
// MAIN WEBHOOK HANDLER
// ===============================
app.post('/webhook', async (req, res) => {
    try {
        const entry = req.body.entry?.[0];
        const change = entry?.changes?.[0];

        if (change?.field !== "messages")
            return res.sendStatus(200);

        const message = change?.value?.messages?.[0];
        if (!message)
            return res.sendStatus(200);

        const messageId = message.id;

        // Duplicate protection
        if (processedMessages.has(messageId)) {
            console.log("Duplicate message ignored.");
            return res.sendStatus(200);
        }

        processedMessages.add(messageId);

        const from = message.from;
        let contentForAI = "";
        let prefix = "";

        // ===============================
        // TEXT
        // ===============================
        if (message.type === "text") {
            contentForAI = message.text.body;
        }

        // ===============================
        // IMAGE
        // ===============================
        if (message.type === "image") {

            prefix = "🖼 ";
            const mediaId = message.image.id;

            const mediaResponse = await axios.get(
                `https://graph.facebook.com/v19.0/${mediaId}`,
                { headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` } }
            );

            const mediaUrl = mediaResponse.data.url;

            const imageResponse = await axios.get(mediaUrl, {
                responseType: 'arraybuffer',
                headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` }
            });

            const imagePath = path.join(__dirname, 'temp_image.jpg');
            fs.writeFileSync(imagePath, imageResponse.data);

            contentForAI = await extractTextFromImage(imagePath);

            fsExtra.removeSync(imagePath);
        }

        // ===============================
        // AUDIO
        // ===============================
        if (message.type === "audio") {

            prefix = "🎤 ";
            const mediaId = message.audio.id;

            const mediaResponse = await axios.get(
                `https://graph.facebook.com/v19.0/${mediaId}`,
                { headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` } }
            );

            const mediaUrl = mediaResponse.data.url;

            const audioResponse = await axios.get(mediaUrl, {
                responseType: 'arraybuffer',
                headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` }
            });

            const audioPath = path.join(__dirname, 'temp_audio.ogg');
            fs.writeFileSync(audioPath, audioResponse.data);

            contentForAI = await transcribeAudio(audioPath);

            fsExtra.removeSync(audioPath);
        }

        if (!contentForAI)
            return res.sendStatus(200);

        console.log("Analyzing:", contentForAI);

        const aiRaw = await analyzeWithAI(contentForAI);
        const parsed = safeParseJSON(aiRaw);

        let reply = "⚠️ Unable to analyze content.";

        if (parsed) {
            reply = prefix + formatReply(parsed);
            logAttack(from, contentForAI, parsed);
        }

        await sendReply(from, reply);

        res.sendStatus(200);

    } catch (error) {
        console.error("Webhook Error FULL:", error);
        res.sendStatus(500);
    }
});


// ===============================
// SAFE JSON PARSER
// ===============================
function safeParseJSON(aiRaw) {
    if (!aiRaw) return null;
    try { return JSON.parse(aiRaw); }
    catch {
        const match = aiRaw.match(/\{[\s\S]*\}/);
        if (match) return JSON.parse(match[0]);
    }
    return null;
}


// ===============================
function formatReply(data) {
    return `🛡 AI Security Report

Risk Score: ${data.risk_score}/100
Category: ${data.category?.toUpperCase()}

Reason:
${data.reason}

Recommendation:
${data.recommendation}`;
}


// ===============================
async function sendReply(to, message) {
    await axios.post(
        `https://graph.facebook.com/v19.0/${process.env.PHONE_NUMBER_ID}/messages`,
        {
            messaging_product: "whatsapp",
            to,
            text: { body: message }
        },
        {
            headers: {
                Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
                "Content-Type": "application/json"
            }
        }
    );
}


// ===============================
function logAttack(number, message, aiData) {

    const logEntry = {
        number,
        message,
        ...aiData,
        timestamp: new Date().toISOString()
    };

    let logs = [];
    if (fs.existsSync(logFilePath))
        logs = JSON.parse(fs.readFileSync(logFilePath));

    logs.push(logEntry);
    fs.writeFileSync(logFilePath, JSON.stringify(logs, null, 2));

    console.log("Threat logged successfully.");
}


// ===============================
app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});