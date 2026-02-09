import amqp from 'amqplib';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import Log from './LogModels.js';
import nodemailer from "nodemailer";
dotenv.config();

// -------------------------------------------------------
// 🔐 RabbitMQ Configuration
// -------------------------------------------------------
const RABBIT_URL = `amqp://${process.env.RABBITMQ_USER}:${process.env.RABBITMQ_PASSWORD}@${process.env.RABBITMQ_HOST}`;
const EXCHANGE_NAME = 'application.logs';
const QUEUE_NAME = 'allLogsQueue';
const ROUTING_KEY = 'log.#';


// -------- EMAIL ALERT TRANSPORT --------
const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
        user: process.env.ALERT_EMAIL,
        pass: process.env.ALERT_PASSWORD,
    },
});



// -------- ALERT FUNCTION --------
const sendAlert = async (subject, message) => {
    try {
        await transporter.sendMail({
            from: process.env.ALERT_EMAIL,
            to: process.env.ALERT_EMAIL_TO,
            subject,
            text: message,
        });

        console.log("Alert sent:", subject);
    } catch (err) {
        console.error("❌ Failed to send alert:", err.message);
    }
};
// -------------------------------------------------------
// 🔥 Buffer, Batch & Flush Config
// -------------------------------------------------------
let logBuffer = [];
const BATCH_SIZE = 100;
const FLUSH_INTERVAL = 1 * 60 * 1000; // 5 minutes
const MAX_BUFFER_SIZE_MB = 5; // Memory safety limit

let isSaving = false; // Prevents overlapping writes
let lastFlushTime = Date.now();

// -------------------------------------------------------
// 🧠 Helper: Calculate Buffer Memory
// -------------------------------------------------------
function calculateBufferSizeMB() {
    const jsonStr = JSON.stringify(logBuffer);
    return Buffer.byteLength(jsonStr) / (1024 * 1024); // in MB
}

// -------------------------------------------------------
// 🗄 Connect MongoDB
// -------------------------------------------------------
async function connectMongo() {
    try {
        const uri = process.env.MONGO_URI;
        const dbName = process.env.MONGO_DB_NAME;

        if (!uri) throw new Error("MONGO_URI is not defined");
        if (!dbName) throw new Error("MONGO_DB_NAME is not defined");

        await mongoose.connect(uri, {
            dbName,
            autoIndex: false,       // production best practice
            serverSelectionTimeoutMS: 10000,
        });

        console.log(`[MongoDB] Connected successfully to database: ${dbName}`);
    } catch (err) {
        console.error("❌ MongoDB connection failed:", err.message);
        process.exit(1); // crash app if DB not connected
    }
}


let connection;
let channel;

async function connectRabbitMQ() {
    connection = await amqp.connect(RABBIT_URL);
    channel = await connection.createChannel();

    await channel.assertExchange(EXCHANGE_NAME, 'topic', { durable: true });
    await channel.assertQueue(QUEUE_NAME, { durable: true });
    await channel.bindQueue(QUEUE_NAME, EXCHANGE_NAME, ROUTING_KEY);

    console.log(`[RabbitMQ] Ready — listening to "${ROUTING_KEY}" on queue "${QUEUE_NAME}"`);
}

async function saveLogsInBatch(force = false) {
    if (isSaving) return;
    if (force && logBuffer.length === 0) return;


    if (!force && logBuffer.length < BATCH_SIZE) return;

    isSaving = true;

    const chunk = logBuffer.splice(0, BATCH_SIZE); // Remove top 100 logs

    try {
        await Log.insertMany(chunk, { ordered: false });

        console.log(`[DB] Saved batch of ${chunk.length} logs`);
    } catch (err) {
        console.error('[DB] Insert error → requeue logs:', err.message);
        logBuffer = chunk.concat(logBuffer);
    }

    isSaving = false;
}

async function flushTimerCheck() {
    const now = Date.now();


    if (now - lastFlushTime >= FLUSH_INTERVAL) {
        console.log('[Timer] 5 min flush triggered');
        await saveLogsInBatch(true);
        lastFlushTime = now;

    }


    const bufferSizeMB = calculateBufferSizeMB();
    if (bufferSizeMB >= MAX_BUFFER_SIZE_MB) {
        console.log(`[Memory] Buffer too large (${bufferSizeMB.toFixed(2)} MB). Flushing...`);
        await saveLogsInBatch(true); // force flush
        lastFlushTime = now;
        await sendAlert(
            "Buffer Size Warning",
            `Buffer exceeded ${MAX_BUFFER_SIZE_MB} items. Flushing early.`
        );
    }
}


async function consumeLogs() {
    try {
        channel.consume(
            QUEUE_NAME,
            async (msg) => {
                if (!msg) return;

                try {
                    const log = JSON.parse(msg.content.toString());
                    logBuffer.push(log);

                    console.log(`[Consumer] Buffered log (#${logBuffer.length})`);

                    channel.ack(msg);
                } catch (err) {
                    console.error('[Consumer] Invalid log JSON:', err.message);
                    channel.nack(msg, false, false);
                }

                await saveLogsInBatch();

                await flushTimerCheck();
            },
            { noAck: false }
        );
    } catch (error) {
        await sendAlert(
            "RabbitMQ Consumer Down",
            `The consumer crashed: ${err.message}`
        );

        console.error("❌ Consumer failed:", err);
        process.exit(1);

    }

}

// -------------------------------------------------------
// 🚀 Start Consumer
// -------------------------------------------------------
async function start() {
    await connectMongo();
    await connectRabbitMQ();
    await consumeLogs();

    console.log('[Log Consumer] Running...');
}

start();
