const express = require('express');
const axios = require('axios');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static('public'));

// 🔑 ဒီနေရာတွင် မိမိ၏ Telegram Bot Token နှင့် Chat ID အမှန်ကို ထည့်ပါ
const TELEGRAM_BOT_TOKEN = '8262489446:AAElYGOaU7gIOpcu-_gpCn3kfvLBLkyRXeM';
const TELEGRAM_CHAT_ID = '-1004295109530';

// Customer Database
const mockDatabase = {
    'tty01072': { name: 'Min thiha', fatBox: 'FAT-01' },
    'tty00001': { name: 'Kyaw Gyi', fatBox: 'FAT-01' },
    'tty00002': { name: 'Aung Aung', fatBox: 'FAT-01' },
    'tty00003': { name: 'Mya Mya', fatBox: 'FAT-02' }
};

const customerLastReportTime = {};
const fatRedLightReports = {};

// 1. Customer ID Lookup API
app.get('/api/get-customer/:id', (req, res) => {
    const customerId = req.params.id.trim().toLowerCase();
    const customerData = mockDatabase[customerId];

    if (customerData) {
        res.json({ success: true, username: customerData.name });
    } else {
        res.json({ success: false, message: 'Customer ID မရှိပါ' });
    }
});

// 2. Report Submit API
app.post('/api/submit-report', async (req, res) => {
    const { customerId, customerName, issue } = req.body;
    const formattedId = customerId.trim().toLowerCase();
    const now = Date.now();
    const todayDate = new Date().toDateString();

    const customerData = mockDatabase[formattedId];
    const fatBox = customerData ? customerData.fatBox : 'Unknown-FAT';

    // Rule 1: Customer တစ်ဦးလျှင် ၁ နေ့ ၁ ကြိမ်
    if (customerLastReportTime[formattedId] === todayDate) {
        return res.json({ 
            success: false, 
            message: 'သင်သည် ယနေ့အတွက် Report တင်ပြီးဖြစ်ပါသည်။ မနက်ဖြန်မှ ပြန်လည်တင်ပြနိုင်ပါမည်။' 
        });
    }

    const reportMessage = `🚨 *ISP Report အသစ်ရောက်ရှိပါသည်* 🚨\n\n` +
                          `👤 *Customer Name:* ${customerName}\n` +
                          `🆔 *Customer ID:* ${customerId.toUpperCase()}\n` +
                          `📦 *FAT Box:* ${fatBox}\n` +
                          `⚠️ *Issue:* ${issue}\n` +
                          `⏰ *Time:* ${new Date().toLocaleString('en-US', { timeZone: 'Asia/Yangon' })}`;

    try {
        await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
            chat_id: TELEGRAM_CHAT_ID,
            text: reportMessage,
            parse_mode: 'Markdown'
        });

        customerLastReportTime[formattedId] = todayDate;

        // Rule 2: FAT Box 1 နာရီအတွင်း မီးနီ 3 ခုအထက် Warning Alert
        if (issue.includes('မီးနီ')) {
            if (!fatRedLightReports[fatBox]) {
                fatRedLightReports[fatBox] = [];
            }

            const oneHourAgo = now - 60 * 60 * 1000;
            fatRedLightReports[fatBox] = fatRedLightReports[fatBox].filter(timestamp => timestamp > oneHourAgo);
            fatRedLightReports[fatBox].push(now);

            if (fatRedLightReports[fatBox].length >= 3) {
                const warningMessage = `⚠️ *FAT BOX WARNING ALERT!* ⚠️\n\n` +
                                       `📍 *FAT Box ID:* ${fatBox}\n` +
                                       `⚡ *Status:* ၁ နာရီအတွင်း မီးနီ Report (${fatRedLightReports[fatBox].length}) ခု ဝင်ရောက်ထားပါသည်။\n` +
                                       `❗ Main Fiber Line သို့မဟုတ် FAT Box အပိုင်း အဓိက ပြဿနာရှိနိုင်ပါသဖြင့် အမြန်ဆုံး စစ်ဆေးပေးပါရန်။`;

                await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
                    chat_id: TELEGRAM_CHAT_ID,
                    text: warningMessage,
                    parse_mode: 'Markdown'
                });
            }
        }

        res.json({ success: true, message: 'Report အောင်မြင်စွာ ပို့ပြီးပါပြီ' });
    } catch (error) {
        console.error('Telegram Error:', error.response ? error.response.data : error.message);
        res.json({ success: false, message: 'Telegram Noti ပို့ရာတွင် အမှားရှိပါသည်' });
    }
});

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
