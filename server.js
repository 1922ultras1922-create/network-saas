require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const app = express();
const PORT = 3000;
const DATA_FILE = path.join(__dirname, 'records.json');

app.use(express.json());
app.use(express.static('public'));

// --- Конфиги из .env ---
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
// Теперь по умолчанию 7000 км
const OIL_CHANGE_KM = parseInt(process.env.OIL_CHANGE_KM) || 7000;
const OIL_CHANGE_DAYS = parseInt(process.env.OIL_CHANGE_DAYS) || 365;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// --- Интервалы для различных типов работ (масло теперь 7000 км) ---
const INTERVALS = {
    'Замена масла': { km: 7000, days: 365 },
    'Замена воздушного фильтра': { km: 15000, days: 365 },
    'Замена топливного фильтра': { km: 30000, days: 730 },
    'Замена свечей': { km: 30000, days: 730 },
    'Замена ремня ГРМ': { km: 60000, days: 1460 },
    'Замена тормозных колодок': { km: 40000, days: 730 },
    'Замена охлаждающей жидкости': { km: 60000, days: 1460 },
    'Замена тормозной жидкости': { km: 40000, days: 730 },
    'Замена трансмиссионного масла': { km: 60000, days: 1460 }
};

// --- Работа с файлом ---
function loadRecords() {
    try {
        if (fs.existsSync(DATA_FILE)) {
            const data = fs.readFileSync(DATA_FILE, 'utf8');
            return JSON.parse(data);
        }
        return [];
    } catch { return []; }
}

function saveRecords(records) {
    fs.writeFileSync(DATA_FILE, JSON.stringify(records, null, 2), 'utf8');
    // Резервное копирование
    try {
        const backupDir = path.join(__dirname, 'backups');
        if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir);
        const backupName = `records_${new Date().toISOString().slice(0,10)}.json`;
        fs.writeFileSync(path.join(backupDir, backupName), JSON.stringify(records, null, 2), 'utf8');
        const files = fs.readdirSync(backupDir).filter(f => f.startsWith('records_'));
        if (files.length > 7) {
            const sorted = files.sort();
            const toDelete = sorted.slice(0, files.length - 7);
            toDelete.forEach(f => fs.unlinkSync(path.join(backupDir, f)));
        }
    } catch (e) { /* игнорируем */ }
}

function getCars(records) {
    const cars = new Set(records.map(r => r.car).filter(Boolean));
    return Array.from(cars);
}

// --- Telegram отправка ---
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

// --- Функция получения статуса ---
function getStatusData(records) {
    const result = {};
    for (const [type, interval] of Object.entries(INTERVALS)) {
        const lastRecords = records.filter(r => r.type === type).sort((a,b) => new Date(b.date) - new Date(a.date));
        const last = lastRecords.length ? lastRecords[0] : null;
        if (!last) {
            result[type] = {
                status: 'never',
                lastMileage: null,
                lastDate: null,
                kmDiff: 0,
                daysDiff: 0,
                kmLeft: null,
                daysLeft: null,
                percent: 0,
                interval: interval
            };
            continue;
        }

        const carRecords = records.filter(r => r.car === last.car);
        const currentMileage = carRecords.length ? Math.max(...carRecords.map(r => r.mileage)) : last.mileage;

        const kmDiff = currentMileage - last.mileage;
        const daysDiff = Math.floor((Date.now() - new Date(last.date)) / (1000*60*60*24));

        const kmLeft = Math.max(0, interval.km - kmDiff);
        const daysLeft = Math.max(0, interval.days - daysDiff);

        let percent = 0;
        if (interval.km > 0 && interval.days > 0) {
            const p1 = Math.min(100, (kmDiff / interval.km) * 100);
            const p2 = Math.min(100, (daysDiff / interval.days) * 100);
            percent = Math.round(Math.max(p1, p2));
        } else if (interval.km > 0) {
            percent = Math.round(Math.min(100, (kmDiff / interval.km) * 100));
        } else if (interval.days > 0) {
            percent = Math.round(Math.min(100, (daysDiff / interval.days) * 100));
        }

        const isOverdue = kmDiff >= interval.km || daysDiff >= interval.days;

        let status = 'good';
        if (isOverdue) status = 'overdue';
        else if (percent > 70) status = 'good';
        else if (percent > 30) status = 'warning';
        else status = 'critical';

        result[type] = {
            status,
            lastMileage: last.mileage,
            lastDate: last.dateLocale,
            kmDiff,
            daysDiff,
            kmLeft,
            daysLeft,
            percent,
            interval
        };
    }
    return result;
}

function getStatusText(records) {
    const data = getStatusData(records);
    let text = '\n📊 <b>Состояние узлов:</b>\n';
    for (const [type, info] of Object.entries(data)) {
        if (info.status === 'never') {
            text += `❌ ${type}: не заменялось\n`;
            continue;
        }
        const statusIcon = info.status === 'good' ? '✅' : info.status === 'warning' ? '⚠️' : info.status === 'critical' ? '🔴' : '🚨';
        text += `${statusIcon} ${type}: ${info.percent}% (осталось ${info.kmLeft !== null ? info.kmLeft + ' км' : '?'}, ${info.daysLeft !== null ? info.daysLeft + ' дн.' : '?'})\n`;
    }
    return text;
}

function sendFullReport(records) {
    if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) return;
    const cars = getCars(records);
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

    message += getStatusText(records);

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

app.get('/api/records', (req, res) => {
    res.json(loadRecords());
});

app.get('/api/cars', (req, res) => {
    const records = loadRecords();
    res.json(getCars(records));
});

app.post('/api/records', (req, res) => {
    const { mileage, description, part, type, car } = req.body;
    if (mileage === undefined || !description || !part || !type || !car) {
        return res.status(400).json({ error: 'Все поля обязательны' });
    }
    const records = loadRecords();
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
    saveRecords(records);
    res.status(201).json(newRecord);

    const carRecords = records.filter(r => r.car === car);
    checkOilChangeAndNotify(carRecords, car);
});

app.delete('/api/records/:id', (req, res) => {
    const id = parseInt(req.params.id);
    let records = loadRecords();
    const filtered = records.filter(r => r.id !== id);
    if (filtered.length === records.length) {
        return res.status(404).json({ error: 'Не найдено' });
    }
    saveRecords(filtered);
    res.json({ success: true });
});

app.post('/api/check-reminders', (req, res) => {
    const records = loadRecords();
    const cars = getCars(records);
    let notifications = 0;

    sendFullReport(records);

    for (const car of cars) {
        const carRecords = records.filter(r => r.car === car);
        const notified = checkOilChangeAndNotify(carRecords, car);
        if (notified) notifications++;
    }
    res.json({ success: true, checked: cars.length, notifications });
});

app.get('/api/status', (req, res) => {
    const records = loadRecords();
    const status = getStatusData(records);
    res.json(status);
});

// --- AI-чат (Gemini) ---
app.post('/api/chat', async (req, res) => {
    const { message, car } = req.body;
    if (!message) return res.status(400).json({ error: 'Сообщение обязательно' });
    if (!GEMINI_API_KEY) {
        return res.status(500).json({ error: 'Gemini API ключ не настроен' });
    }

    const records = loadRecords();
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
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent?key=${GEMINI_API_KEY}`,
            { contents: [{ parts: [{ text: prompt }] }] },
            { headers: { 'Content-Type': 'application/json' } }
        );
        const reply = response.data.candidates[0].content.parts[0].text;
        res.json({ reply });
    } catch (error) {
        console.error('Gemini error DETAILS:', JSON.stringify(error.response?.data, null, 2) || error.message);
        res.status(500).json({ error: 'Ошибка AI-сервиса: ' + (error.response?.data?.error?.message || 'неизвестная') });
    }
});

// --- Планировщик ---
setInterval(() => {
    const records = loadRecords();
    const cars = getCars(records);
    for (const car of cars) {
        const carRecords = records.filter(r => r.car === car);
        checkOilChangeAndNotify(carRecords, car);
    }
}, 6 * 60 * 60 * 1000);

setTimeout(() => {
    const records = loadRecords();
    const cars = getCars(records);
    for (const car of cars) {
        const carRecords = records.filter(r => r.car === car);
        checkOilChangeAndNotify(carRecords, car);
    }
}, 5000);

// --- Приём сообщений из Telegram ---
if (TELEGRAM_TOKEN && TELEGRAM_CHAT_ID) {
    let lastUpdateId = 0;

    async function pollTelegram() {
        try {
            const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/getUpdates`;
            const params = {
                offset: lastUpdateId + 1,
                timeout: 30,
                allowed_updates: ['message']
            };
            const response = await axios.get(url, { params });
            const updates = response.data.result;

            for (const update of updates) {
                const msg = update.message;
                if (!msg) continue;
                const chatId = msg.chat.id;
                if (chatId.toString() !== TELEGRAM_CHAT_ID) {
                    console.log(`Сообщение от чужого chat_id: ${chatId}`);
                    continue;
                }
                const text = msg.text ? msg.text.trim() : '';
                if (!text) continue;

                if (update.update_id > lastUpdateId) {
                    lastUpdateId = update.update_id;
                }

                if (text.startsWith('/')) {
                    await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
                        chat_id: chatId,
                        text: 'Пришлите данные в формате:\n`пробег;узел;тип;описание;автомобиль`\n\nПример:\n`15000;Двигатель;Замена масла;Замена масла;Lada Priora`',
                        parse_mode: 'Markdown'
                    });
                    continue;
                }

                const parts = text.split(';').map(s => s.trim());
                if (parts.length < 5) {
                    await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
                        chat_id: chatId,
                        text: '❌ Неверный формат. Нужно 5 полей через точку с запятой:\n`пробег;узел;тип;описание;автомобиль`'
                    });
                    continue;
                }

                const [mileageStr, part, type, description, car] = parts;
                const mileage = parseInt(mileageStr);
                if (isNaN(mileage) || mileage < 0) {
                    await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
                        chat_id: chatId,
                        text: '❌ Пробег должен быть целым числом ≥ 0'
                    });
                    continue;
                }

                const records = loadRecords();
                const newRecord = {
                    id: Date.now(),
                    mileage: Number(mileage),
                    description: description || 'Без описания',
                    part: part || 'Другое',
                    type: type || 'Другое',
                    car: car || 'Неизвестно',
                    date: new Date().toISOString(),
                    dateLocale: new Date().toLocaleString()
                };
                records.push(newRecord);
                saveRecords(records);

                await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
                    chat_id: chatId,
                    text: `✅ Запись добавлена:\n🚗 ${newRecord.car}\n📏 ${newRecord.mileage} км\n🔧 ${newRecord.part}\n📝 ${newRecord.description}`
                });

                const carRecords = records.filter(r => r.car === car);
                checkOilChangeAndNotify(carRecords, car);
            }
        } catch (error) {
            if (error.response && error.response.status === 409) {
                console.warn('⚠️ Конфликт токена (409). Возможно, бот уже запущен. Повтор через 30 секунд...');
            } else {
                console.error('Ошибка при опросе Telegram:', error.message);
            }
        }
    }

    setInterval(pollTelegram, 2000);
    setTimeout(pollTelegram, 1000);
    console.log('🤖 Бот запущен в режиме long polling (альтернативный)');
} else {
    console.warn('⚠️ TELEGRAM_TOKEN или TELEGRAM_CHAT_ID не задан, бот не запущен');
}

// --- Запуск сервера ---
app.listen(PORT, () => {
    console.log(`🚀 Сервер запущен: http://localhost:${PORT}`);
    console.log(`📏 Порог замены масла: ${OIL_CHANGE_KM} км или ${OIL_CHANGE_DAYS} дней`);
});