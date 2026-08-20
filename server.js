require('dotenv').config();
const express = require('express');
const path = require('path');
const axios = require('axios');
const { MongoClient } = require('mongodb');

const app = express();
const PORT = process.env.PORT || 3000;
// force redeploy 2025-03-20
app.use(express.json());
app.use(express.static('public'));

// --- Конфиги из .env ---
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const OIL_CHANGE_KM = parseInt(process.env.OIL_CHANGE_KM) || 10000;
const OIL_CHANGE_DAYS = parseInt(process.env.OIL_CHANGE_DAYS) || 180;
const YANDEX_API_KEY = process.env.YANDEX_API_KEY;
const YANDEX_FOLDER_ID = process.env.YANDEX_FOLDER_ID;

// --- MongoDB ---
const DB_URL = process.env.DATABASE_URL; // ваша строка подключения
const DB_NAME = process.env.DB_NAME || 'mileage';
let db;

async function connectDB() {
    if (!DB_URL) {
        console.warn('⚠️ DATABASE_URL не задан, работаем в режиме JSON (только для локального теста)');
        return;
    }
    try {
        const client = new MongoClient(DB_URL);
        await client.connect();
        db = client.db(DB_NAME);
        console.log('✅ Подключено к MongoDB');
    } catch (e) {
        console.error('❌ Ошибка подключения к MongoDB:', e.message);
        process.exit(1);
    }
}

// --- Функции работы с данными (асинхронные) ---
async function loadRecords() {
    if (!db) {
        // fallback на JSON (для локальной разработки без MongoDB)
        try {
            const fs = require('fs');
            const data = fs.readFileSync(path.join(__dirname, 'records.json'), 'utf8');
            return JSON.parse(data);
        } catch { return []; }
    }
    return await db.collection('records').find({}).toArray();
}

async function saveRecords(records) {
    if (!db) {
        const fs = require('fs');
        fs.writeFileSync(path.join(__dirname, 'records.json'), JSON.stringify(records, null, 2));
        return;
    }
    // Полная замена коллекции (проще для начала)
    await db.collection('records').deleteMany({});
    if (records.length > 0) {
        await db.collection('records').insertMany(records);
    }
}

async function getCars() {
    const records = await loadRecords();
    const cars = new Set(records.map(r => r.car).filter(Boolean));
    return Array.from(cars);
}

// --- Telegram ---
async function sendTelegramMessage(message) {
    if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) return false;
    try {
        await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
            chat_id: TELEGRAM_CHAT_ID,
            text: message,
            parse_mode: 'HTML'
        });
        return true;
    } catch (e) {
        console.error('Telegram error:', e.response?.data || e.message);
        return false;
    }
}

function sendFullReport(records) {
    if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) return;
    const cars = [...new Set(records.map(r => r.car).filter(Boolean))];
    if (cars.length === 0) {
        sendTelegramMessage("📋 В системе нет записей.");
        return;
    }
    let message = "📊 <b>Сводка по всем автомобилям:</b>\n\n";
    for (const car of cars) {
        const carRecords = records.filter(r => r.car === car);
        message += `<b>🚗 ${car}</b> (${carRecords.length} записей):\n`;
        const sorted = carRecords.sort((a,b) => new Date(b.date) - new Date(a.date));
        sorted.forEach(r => {
            message += `  • ${r.mileage} км | ${r.part} | ${r.type} | ${r.description} (${r.dateLocale})\n`;
        });
        const last = getLastOilChange(carRecords);
        if (last) {
            const currentMileage = Math.max(...carRecords.map(r => r.mileage));
            const kmDiff = currentMileage - last.mileage;
            const daysDiff = Math.floor((Date.now() - new Date(last.date)) / (1000*60*60*24));
            if (kmDiff >= OIL_CHANGE_KM || daysDiff >= OIL_CHANGE_DAYS) {
                message += `  ⚠️ <b>Нужна замена масла!</b> (пробег с замены: ${kmDiff} км, дней: ${daysDiff})\n`;
            }
        }
        message += "\n";
    }
    if (message.length > 4000) {
        message = message.substring(0, 4000) + "\n... (сообщение обрезано)";
    }
    sendTelegramMessage(message);
}

function getLastOilChange(records) {
    const oilChanges = records
        .filter(r => r.type === 'Замена масла')
        .sort((a, b) => new Date(b.date) - new Date(a.date));
    return oilChanges.length ? oilChanges[0] : null;
}

function checkOilChangeAndNotify(records, car) {
    const last = getLastOilChange(records);
    if (!last) return false;

    const now = new Date();
    const lastDate = new Date(last.date);
    const daysDiff = Math.floor((now - lastDate) / (1000 * 60 * 60 * 24));
    const lastMileage = last.mileage;
    const currentMileage = records.length ? Math.max(...records.map(r => r.mileage)) : lastMileage;
    const kmDiff = currentMileage - lastMileage;

    let needNotify = false;
    let reason = '';
    if (kmDiff >= OIL_CHANGE_KM) {
        needNotify = true;
        reason = `пробег с замены ${kmDiff} км (лимит ${OIL_CHANGE_KM} км)`;
    } else if (daysDiff >= OIL_CHANGE_DAYS) {
        needNotify = true;
        reason = `прошло ${daysDiff} дней (лимит ${OIL_CHANGE_DAYS} дней)`;
    }

    if (needNotify) {
        const msg = `
⚠️ <b>Напоминание о замене масла (${car})</b>

Последняя замена: ${last.dateLocale}
Пробег на замене: ${lastMileage} км
Текущий пробег: ${currentMileage} км
Пробег после замены: ${kmDiff} км
Дней прошло: ${daysDiff}

Причина: ${reason}
Рекомендуется заменить масло.
        `.trim();
        sendTelegramMessage(msg);
        return true;
    }
    return false;
}

// --- API маршруты ---
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/api/records', async (req, res) => {
    const records = await loadRecords();
    res.json(records);
});

app.get('/api/cars', async (req, res) => {
    const cars = await getCars();
    res.json(cars);
});

app.post('/api/records', async (req, res) => {
    const { mileage, description, part, type, car } = req.body;
    if (mileage === undefined || !description || !part || !type || !car) {
        return res.status(400).json({ error: 'Все поля обязательны' });
    }
    const records = await loadRecords();
    const newRecord = {
        id: Date.now(),
        mileage: Number(mileage),
        description: description.trim(),
        part,
        type,
        car: car.trim(),
        date: new Date().toISOString(),
        dateLocale: new Date().toLocaleString()
    };
    records.push(newRecord);
    await saveRecords(records);
    res.status(201).json(newRecord);

    const carRecords = records.filter(r => r.car === car);
    checkOilChangeAndNotify(carRecords, car);
});

app.delete('/api/records/:id', async (req, res) => {
    const id = parseInt(req.params.id);
    let records = await loadRecords();
    const filtered = records.filter(r => r.id !== id);
    if (filtered.length === records.length) {
        return res.status(404).json({ error: 'Не найдено' });
    }
    await saveRecords(filtered);
    res.json({ success: true });
});

app.post('/api/check-reminders', async (req, res) => {
    const records = await loadRecords();
    const cars = await getCars();
    let notifications = 0;

    sendFullReport(records);

    for (const car of cars) {
        const carRecords = records.filter(r => r.car === car);
        const notified = checkOilChangeAndNotify(carRecords, car);
        if (notified) notifications++;
    }
    res.json({ success: true, checked: cars.length, notifications });
});

// --- AI-чат (YandexGPT) ---
app.post('/api/chat', async (req, res) => {
    const { message, car } = req.body;
    if (!message) return res.status(400).json({ error: 'Сообщение обязательно' });
    if (!YANDEX_API_KEY || !YANDEX_FOLDER_ID) {
        return res.status(500).json({ error: 'YandexGPT не настроен' });
    }

    const records = await loadRecords();
    const carRecords = records.filter(r => r.car === car).slice(-5);
    let context = `Автомобиль: ${car}\n`;
    if (carRecords.length) {
        context += 'Последние записи:\n';
        carRecords.forEach(r => {
            context += `- Пробег ${r.mileage} км, ${r.part}, ${r.type}: ${r.description}\n`;
        });
    } else {
        context += 'Нет записей по этому авто.\n';
    }

    const prompt = `Ты — эксперт по обслуживанию автомобилей. Пользователь спрашивает: "${message}". 
Учитывай контекст:
${context}
Дай полезный, краткий совет (не более 3 предложений).`;

    try {
        const response = await axios.post(
            'https://llm.api.cloud.yandex.net/foundationModels/v1/completion',
            {
                modelUri: `gpt://${YANDEX_FOLDER_ID}/yandexgpt-lite/latest`,
                completionOptions: { stream: false, temperature: 0.5, maxTokens: 200 },
                messages: [
                    { role: 'system', text: 'Ты — автоэксперт, отвечай кратко и по делу.' },
                    { role: 'user', text: prompt }
                ]
            },
            { headers: { 'Authorization': `Api-Key ${YANDEX_API_KEY}`, 'Content-Type': 'application/json' } }
        );
        const reply = response.data.result.alternatives[0].message.text;
        res.json({ reply });
    } catch (error) {
        console.error('YandexGPT error:', error.response?.data || error.message);
        res.status(500).json({ error: 'Ошибка AI-сервиса' });
    }
});

// --- Планировщик (каждые 6 часов) ---
setInterval(async () => {
    const records = await loadRecords();
    const cars = await getCars();
    for (const car of cars) {
        const carRecords = records.filter(r => r.car === car);
        checkOilChangeAndNotify(carRecords, car);
    }
}, 6 * 60 * 60 * 1000);

setTimeout(async () => {
    const records = await loadRecords();
    const cars = await getCars();
    for (const car of cars) {
        const carRecords = records.filter(r => r.car === car);
        checkOilChangeAndNotify(carRecords, car);
    }
}, 5000);

// --- Запуск сервера после подключения к БД ---
connectDB().then(() => {
    app.listen(PORT, () => {
        console.log(`🚀 Сервер запущен на порту ${PORT}`);
        console.log(`📏 Пороги: ${OIL_CHANGE_KM} км или ${OIL_CHANGE_DAYS} дней`);
    });
}).catch(err => {
    console.error('Не удалось запустить сервер:', err);
    process.exit(1);
});