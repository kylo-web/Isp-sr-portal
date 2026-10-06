const express = require('express');
const axios = require('axios');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static('public'));

// ⚠️ မိမိ၏ Telegram Bot Token နှင့် Group Chat ID ထည့်ရန်
const TELEGRAM_BOT_TOKEN = '8262489446:AAElYGOaU7gIOpcu-_gpCn3kfvLBLkyRXeM';
const TELEGRAM_CHAT_ID = '-1004295109530';

// Customer Database
const mockDatabase = {
    'Tty01072': 'Min thiha',
    'Tty00001': 'Kyaw Gyi',
    'Tty00002': 'Aung Aung'
};

// Customer ID Lookup API
app.get('/api/get-customer/:id', (req, res) => {
    const customerId = req.params.id;
    const customerName = mockDatabase[customerId];

    if (customerName) {
        res.json({ success: true, username: customerName });
    } else {
        res.json({ success: false, message: 'Customer ID မရှိပါ' });
    }
});

// Telegram သို့ Report Alert ပို့ပေးမည့် API
app.post('/api/submit-report', async (req, res) => {
    const { customerId, customerName, issue } = req.body;

    const message = `🚨 *ISP Report အသစ်ရောက်ရှိပါသည်* 🚨\n\n` +
                    `👤 *Customer Name:* ${customerName}\n` +
                    `🆔 *Customer ID:* ${customerId}\n` +
                    `⚠️ *Issue:* ${issue}\n` +
                    `⏰ *Time:* ${new Date().toLocaleString()}`;

    try {
        await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
            chat_id: TELEGRAM_CHAT_ID,
            text: message,
            parse_mode: 'Markdown'
        });

        res.json({ success: true, message: 'Report ပို့ပြီးပါပြီ' });
    } catch (error) {
        console.error('Telegram Error:', error.response ? error.response.data : error.message);
        res.json({ success: false, message: 'Telegram Noti ပို့ရာတွင် အမှားရှိပါသည်' });
    }
});

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
