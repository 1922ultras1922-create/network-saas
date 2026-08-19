require('dotenv').config();
const axios = require('axios');

const token = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;

if (!token || !chatId) {
    console.error('Нет токена или chat_id в .env');
    process.exit(1);
}

async function test() {
    try {
        const res = await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
            chat_id: chatId,
            text: '✅ Тестовое сообщение от вашего бота! Если вы это видите, значит отправка работает.'
        });
        console.log('Сообщение отправлено! Ответ:', res.data);
    } catch (e) {
        console.error('Ошибка отправки:', e.response?.data || e.message);
    }
}
test();