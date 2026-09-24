require('dotenv').config();
const express = require('express');
const path = require('path');
const axios = require('axios');
const { MongoClient } = require('mongodb');
const crypto = require('crypto');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static('public'));

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const GIGACHAT_CREDENTIALS = process.env.GIGACHAT_CREDENTIALS;

const CHECK_INTERVAL_HOURS = parseInt(process.env.CHECK_INTERVAL_HOURS) || 6;
const OIL_INTERVAL_KM = 7000; // каждые 7000 км

const REMINDER_TYPES = [
    { type: 'Замена масла', km: OIL_INTERVAL_KM, days: parseInt(process.env.OIL_CHANGE_DAYS) || 180 },
    { type: 'Замена фильтра', km: parseInt(process.env.FILTER_CHANGE_KM) || 15000, days: parseInt(process.env.FILTER_CHANGE_DAYS) || 365 },
    { type: 'Замена ремня ГРМ', km: parseInt(process.env.BELT_CHANGE_KM) || 60000, days: parseInt(process.env.BELT_CHANGE_DAYS) || 0 },
].filter(t => t.km > 0 || t.days > 0);

const DB_URL = process.env.DATABASE_URL;
const DB_NAME = process.env.DB_NAME || 'mileage';
let db;

async function connectDB() {
    if (!DB_URL) {
        console.warn('⚠️ DATABASE_URL не задан, работаем в режиме JSON');
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

async function loadRecords() {
    if (!db) {
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

function getLastWork(records, type) {
    const filtered = records.filter(r => {
        const searchText = [
            r.type,
            r.description,
            r.part,
            r.component
        ].filter(Boolean).join(' ').toLowerCase();
        return searchText.includes(type.toLowerCase().replace('замена ', ''));
    });
    if (filtered.length === 0) return null;
    return filtered.sort((a, b) => new Date(b.date) - new Date(a.date))[0];
}

function checkAllReminders(records, car) {
    let notified = false;
    for (const t of REMINDER_TYPES) {
        const last = getLastWork(records, t.type);
        if (!last) continue;
        const now = new Date();
        const lastDate = new Date(last.date);
        const daysDiff = Math.floor((now - lastDate) / (1000 * 60 * 60 * 24));
        const currentMileage = records.length ? Math.max(...records.map(r => r.mileage)) : last.mileage;
        const kmDiff = currentMileage - last.mileage;
        let needNotify = false;
        let reason = '';
        if (t.km > 0 && kmDiff >= t.km) {
            needNotify = true;
            reason = `пробег с замены ${kmDiff} км (лимит ${t.km} км)`;
        } else if (t.days > 0 && daysDiff >= t.days) {
            needNotify = true;
            reason = `прошло ${daysDiff} дней (лимит ${t.days} дней)`;
        }
        if (needNotify) {
            const msg = `⚠️ <b>Напоминание о ${t.type} (${car})</b>

Последняя ${t.type}: ${last.dateLocale}
Пробег на тот момент: ${last.mileage} км
Текущий пробег: ${currentMileage} км
Пробег после: ${kmDiff} км
Дней прошло: ${daysDiff}

Причина: ${reason}
Рекомендуется выполнить ${t.type}.`;
            sendTelegramMessage(msg);
            notified = true;
        }
    }
    return notified;
}

// ============================================================
// МАРШРУТЫ
// ============================================================

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
    checkAllReminders(carRecords, car);
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

// ============================================================
// --- МОНИТОРИНГ СОСТОЯНИЯ ---
// ============================================================

async function getStatusCollection() {
    if (!db) return null;
    return db.collection('status');
}

app.post('/api/status', async (req, res) => {
    try {
        const {
            rpm, speed, coolantTemp, engineLoad, throttlePos,
            intakeTemp, voltage, fuelRate, oilTemp
        } = req.body;

        if (rpm === undefined) {
            return res.status(400).json({ error: 'Нет данных для мониторинга' });
        }

        const statusData = {
            rpm: Number(rpm) || 0,
            speed: Number(speed) || 0,
            coolantTemp: Number(coolantTemp) || 0,
            engineLoad: Number(engineLoad) || 0,
            throttlePos: Number(throttlePos) || 0,
            intakeTemp: Number(intakeTemp) || 0,
            voltage: Number(voltage) || 0,
            fuelRate: Number(fuelRate) || 0,
            oilTemp: Number(oilTemp) || 0,
            timestamp: new Date().toISOString()
        };

        const collection = await getStatusCollection();
        if (collection) {
            await collection.deleteMany({});
            await collection.insertOne(statusData);
        } else {
            global.lastStatus = statusData;
        }

        console.log('📡 Получен статус:', statusData);
        res.json({ success: true, data: statusData });
    } catch (e) {
        console.error('Status POST error:', e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

app.get('/api/status', async (req, res) => {
    try {
        // === 1. Расчёт масла ===
        const records = await loadRecords();
        const currentMileage = records.length
            ? Math.max(...records.map(r => r.mileage))
            : 0;

        // Универсальный фильтр — ищет "масл" во всех текстовых полях
        const oilChanges = records.filter(r => {
            const searchText = [
                r.type,
                r.description,
                r.part,
                r.component,
                r.car
            ].filter(Boolean).join(' ').toLowerCase();
            return searchText.includes('масл');
        });
        const lastOilChange = oilChanges.length
            ? oilChanges.sort((a, b) => new Date(b.date) - new Date(a.date))[0]
            : null;

        let oilInfo = {
            interval: OIL_INTERVAL_KM,
            currentMileage: currentMileage,
            lastChangeMileage: null,
            kmSinceChange: null,
            kmRemaining: null,
            percentUsed: null,
            lastChangeDate: null,
            status: 'unknown',
            debug: {
                totalRecords: records.length,
                oilChangesFound: oilChanges.length
            }
        };

        if (lastOilChange) {
            const kmSinceChange = currentMileage - lastOilChange.mileage;
            const kmRemaining = Math.max(0, OIL_INTERVAL_KM - kmSinceChange);
            const percentUsed = Math.min(100, Math.round((kmSinceChange / OIL_INTERVAL_KM) * 100));

            oilInfo.lastChangeMileage = lastOilChange.mileage;
            oilInfo.kmSinceChange = kmSinceChange;
            oilInfo.kmRemaining = kmRemaining;
            oilInfo.percentUsed = percentUsed;
            oilInfo.lastChangeDate = lastOilChange.dateLocale || lastOilChange.date;

            if (kmRemaining <= 0) oilInfo.status = 'overdue';
            else if (kmRemaining <= 500) oilInfo.status = 'soon';
            else oilInfo.status = 'ok';
        }

        // === 2. Статус мониторинга ===
        const collection = await getStatusCollection();
        let status = null;

        if (collection) {
            status = await collection.findOne({}, { sort: { timestamp: -1 } });
        } else if (global.lastStatus) {
            status = global.lastStatus;
        }

        if (!status) {
            return res.json({
                success: true,
                stale: true,
                message: 'Нет данных мониторинга. Подключите OBD2Manual.',
                data: null,
                oil: oilInfo
            });
        }

        const age = Date.now() - new Date(status.timestamp).getTime();
        const isStale = age > 5 * 60 * 1000;

        res.json({
            success: true,
            stale: isStale,
            data: status,
            oil: oilInfo
        });
    } catch (e) {
        console.error('Status GET error:', e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post('/api/check-reminders', async (req, res) => {
    const records = await loadRecords();
    const cars = await getCars();
    let notifications = 0;
    for (const car of cars) {
        const carRecords = records.filter(r => r.car === car);
        const notified = checkAllReminders(carRecords, car);
        if (notified) notifications++;
    }
    res.json({ success: true, checked: cars.length, notifications });
});

// ============================================================
// --- AI-ЧАТ ---
// ============================================================

function emulateAI(message, car) {
    const lowerMsg = message.toLowerCase();
    if (lowerMsg.includes('масло')) {
        return `Для автомобиля ${car} рекомендую менять масло каждые ${OIL_INTERVAL_KM} км или раз в год. Учитывая текущий пробег, проверьте последнюю замену в ваших записях.`;
    }
    if (lowerMsg.includes('фильтр')) {
        return `Рекомендуется менять воздушный фильтр каждые 15 000 км, а салонный — раз в год. Для ${car} лучше придерживаться регламента производителя.`;
    }
    if (lowerMsg.includes('ремонт') || lowerMsg.includes('поломка')) {
        return `Для диагностики ${car} лучше обратиться к специалисту. Проверьте коды ошибок через OBD-адаптер.`;
    }
    return `По вашему вопросу "${message}" для ${car} рекомендую обратиться к руководству по эксплуатации или к автомеханику.`;
}

const GIGA_MODELS = ['GigaChat-2-Pro', 'GigaChat'];

app.post('/api/chat', async (req, res) => {
    const { message, car } = req.body;
    if (!message) return res.status(400).json({ error: 'Сообщение обязательно' });

    if (!GIGACHAT_CREDENTIALS) {
        const reply = emulateAI(message, car);
        return res.json({ reply });
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

    const agent = new https.Agent({ rejectUnauthorized: false });

    try {
        const authResponse = await axios.post(
            'https://ngw.devices.sberbank.ru:9443/api/v2/oauth',
            'scope=GIGACHAT_API_PERS',
            {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Accept': 'application/json',
                    'RqUID': crypto.randomUUID(),
                    'Authorization': `Bearer ${GIGACHAT_CREDENTIALS}`
                },
                httpsAgent: agent
            }
        );
        const accessToken = authResponse.data.access_token;

        for (const model of GIGA_MODELS) {
            try {
                const chatResponse = await axios.post(
                    'https://gigachat.devices.sberbank.ru/api/v1/chat/completions',
                    {
                        model: model,
                        messages: [
                            { role: 'system', content: 'Ты — автоэксперт, отвечай кратко и по делу.' },
                            { role: 'user', content: prompt }
                        ],
                        temperature: 0.5,
                        max_tokens: 200
                    },
                    {
                        headers: {
                            'Content-Type': 'application/json',
                            'Accept': 'application/json',
                            'Authorization': `Bearer ${accessToken}`
                        },
                        httpsAgent: agent
                    }
                );
                const reply = chatResponse.data.choices[0]?.message?.content || 'Нет ответа';
                return res.json({ reply });
            } catch (error) {
                console.error(`Модель ${model} не сработала:`, error.response?.data?.message || error.message);
            }
        }

        const reply = emulateAI(message, car);
        res.json({ reply });
    } catch (error) {
        console.error('GigaChat auth error:', error.response?.data || error.message);
        const reply = emulateAI(message, car);
        res.json({ reply });
    }
});

// ============================================================
// ПЕРИОДИЧЕСКАЯ ПРОВЕРКА НАПОМИНАНИЙ
// ============================================================

const CHECK_INTERVAL_MS = CHECK_INTERVAL_HOURS * 60 * 60 * 1000;
setInterval(async () => {
    const records = await loadRecords();
    const cars = await getCars();
    for (const car of cars) {
        const carRecords = records.filter(r => r.car === car);
        checkAllReminders(carRecords, car);
    }
}, CHECK_INTERVAL_MS);

setTimeout(async () => {
    const records = await loadRecords();
    const cars = await getCars();
    for (const car of cars) {
        const carRecords = records.filter(r => r.car === car);
        checkAllReminders(carRecords, car);
    }
}, 5000);

// ============================================================
// ЗАПУСК СЕРВЕРА
// ============================================================

connectDB().then(() => {
    app.listen(PORT, () => {
        console.log(`🚀 Сервер запущен на порту ${PORT}`);
        console.log(`🛢️ Интервал замены масла: ${OIL_INTERVAL_KM} км`);
        console.log('📡 Мониторинг: /api/status (GET/POST)');
        console.log('🤖 AI-чат: /api/chat');
    });
}).catch(err => {
    console.error('Не удалось запустить сервер:', err);
    process.exit(1);
});