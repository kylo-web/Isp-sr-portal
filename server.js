const express = require('express');
const axios = require('axios');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static('public'));

// Telegram Bot Token နှင့် Chat ID
const TELEGRAM_BOT_TOKEN = '8262489446:AAElYGOaU7gIOpcu-_gpCn3kfvLBLkyRXeM';
const TELEGRAM_CHAT_ID = '-1004295109530';

// Customer Database (FAT Box ID များပါ ထည့်သွင်းထားပါသည်)
const mockDatabase = {
    'Tty01072': { name: 'Min thiha', fatBox: 'FAT-01' },
    'Tty00001': { name: 'Kyaw Gyi', fatBox: 'FAT-01' },
    'Tty00002': { name: 'Aung Aung', fatBox: 'FAT-01' },
    'Tty00003': { name: 'Mya Mya', fatBox: 'FAT-02' }
};

// Data Storage (ဆာဗာ ပိတ်/ပွင့်ချိန်အတွင်း မှတ်ထားရန်)
const customerLastReportTime = {}; // Customer တင်သည့် စာရင်း
const fatRedLightReports = {};     // FAT Box အလိုက် မီးနီ Report စာရင်း

// 1. Customer ID Lookup API
app.get('/api/get-customer/:id', (req, res) => {
    const customerId = req.params.id;
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
    const now = Date.now();
    const todayDate = new Date().toDateString();

    const customerData = mockDatabase[customerId];
    const fatBox = customerData ? customerData.fatBox : 'Unknown-FAT';

    // Rule 1: Customer တစ်ဦးလျှင် ၁ နေ့လျှင် ၁ ကြိမ်သာ တင်ခွင့်ပြုခြင်း
    if (customerLastReportTime[customerId] === todayDate) {
        return res.json({ 
            success: false, 
            message: 'သင်သည် ယနေ့အတွက် Report တင်ပြီးဖြစ်ပါသည်။ မနက်ဖြန်မှ ပြန်လည်တင်ပြနိုင်ပါမည်။' 
        });
    }

    // Telegram သို့ ပုံမှန် Report Noti ပို့ခြင်း
    const reportMessage = `🚨 *ISP Report အသစ်ရောက်ရှိပါသည်* 🚨\n\n` +
                          `👤 *Customer Name:* ${customerName}\n` +
                          `🆔 *Customer ID:* ${customerId}\n` +
                          `📦 *FAT Box:* ${fatBox}\n` +
                          `⚠️ *Issue:* ${issue}\n` +
                          `⏰ *Time:* ${new Date().toLocaleString()}`;

    try {
        await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
            chat_id: TELEGRAM_CHAT_ID,
            text: reportMessage,
            parse_mode: 'Markdown'
        });

        // တင်ပြီးကြောင်း သတ်မှတ်
        customerLastReportTime[customerId] = todayDate;

        // Rule 2: FAT Box တစ်ခုတည်းမှ ၁ နာရီအတွင်း မီးနီ Report ၃ ခုနှင့်အထက် စစ်ဆေးခြင်း
        if (issue.includes('မီးနီ')) {
            if (!fatRedLightReports[fatBox]) {
                fatRedLightReports[fatBox] = [];
            }

            // ၁ နာရီ (60 min = 3,600,000 ms) ထက် ကျော်လွန်သော Report အဟောင်းများကို စာရင်းမှ ဖျက်ထုတ်ခြင်း
            const oneHourAgo = now - 60 * 60 * 1000;
            fatRedLightReports[fatBox] = fatRedLightReports[fatBox].filter(timestamp => timestamp > oneHourAgo);

            // လက်ရှိ Report အချိန်ကို ထည့်ခြင်း
            fatRedLightReports[fatBox].push(now);

            // ၁ နာရီအတွင်း မီးနီ Report ၃ ခု သို့မဟုတ် ၃ ခုထက်ပိုပါက Warning Alert ပို့ခြင်း
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
