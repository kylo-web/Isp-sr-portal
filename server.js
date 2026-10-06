const express = require('express');
const axios = require('axios');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static('public'));

// 🔑 Telegram Config
const TELEGRAM_BOT_TOKEN = '8262489446:AAElYGOaU7gIOpcu-_gpCn3kfvLBLkyRXeM';
const TELEGRAM_CHAT_ID = '-1004295109530';

// 🌐 SmartOLT API Config
const SMARTOLT_DOMAIN = 'infinet-mm.smartolt.com'.replace(/^https?:\/\//, '').replace(/\/$/, '');
const SMARTOLT_API_KEY = 'accea08359014b738df318ae274218e3';

const customerLastReportTime = {};
const fatRedLightReports = {};

// ID Format အမျိုးမျိုး ပြောင်းပေးသည့် Function (tty797 -> tty00797, tty0797, tty797)
function generatePossibleIDs(rawId) {
    const cleaned = rawId.trim().toLowerCase();
    const match = cleaned.match(/^([a-z]+)?(\d+)$/);

    if (!match) return [cleaned];

    const prefix = match[1] || 'tty';
    const num = parseInt(match[2], 10);

    const ids = new Set();
    ids.add(cleaned);
    ids.add(`${prefix}${num}`);
    ids.add(`${prefix}${String(num).padStart(3, '0')}`);
    ids.add(`${prefix}${String(num).padStart(4, '0')}`);
    ids.add(`${prefix}${String(num).padStart(5, '0')}`);

    return Array.from(ids);
}

// SmartOLT API မှ Customer ရှာဖွေခြင်း
app.get('/api/get-customer/:id', async (req, res) => {
    const rawId = req.params.id.trim();
    const possibleIds = generatePossibleIDs(rawId);

    const baseUrl = SMARTOLT_DOMAIN.includes('.') 
        ? `https://${SMARTOLT_DOMAIN}/api/onu/get_all_onus_details`
        : `https://${SMARTOLT_DOMAIN}.smartolt.com/api/onu/get_all_onus_details`;

    try {
        // SmartOLT ထဲမှ ONU Data များအားလုံး တောင်းယူမည်
        const response = await axios.get(baseUrl, {
            headers: { 
                'X-Token': SMARTOLT_API_KEY,
                'Accept': 'application/json'
            },
            timeout: 10000
        });

        if (response.data && response.data.onus && Array.isArray(response.data.onus)) {
            const allOnus = response.data.onus;

            // ရိုက်ထည့်လိုက်သော ID နှင့် တိကျစွာ ကိုက်ညီသည့် ONU ကို ရှာမည်
            const matchedOnu = allOnus.find(onu => {
                const customId = (onu.custom_id || '').toLowerCase();
                const name = (onu.name || '').toLowerCase();
                
                return possibleIds.some(pId => customId === pId || name.includes(pId));
            });

            if (matchedOnu) {
                return res.json({
                    success: true,
                    username: matchedOnu.name || matchedOnu.custom_id,
                    fatBox: matchedOnu.zone_name || matchedOnu.odb_name || 'Unknown-FAT'
                });
            }
        }

        res.json({ success: false, message: 'SmartOLT ထဲတွင် Customer ID မတွေ့ရှိပါ' });

    } catch (error) {
        console.error('SmartOLT API Error:', error.response ? error.response.data : error.message);
        res.json({ success: false, message: 'SmartOLT ချိတ်ဆက်မှု အဆင်မပြေပါ' });
    }
});

// Report Submit API
app.post('/api/submit-report', async (req, res) => {
    const { customerId, customerName, issue, fatBox } = req.body;
    const formattedId = customerId.trim().toLowerCase();
    const now = Date.now();
    const todayDate = new Date().toDateString();

    const currentFatBox = fatBox || 'Unknown-FAT';

    if (customerLastReportTime[formattedId] === todayDate) {
        return res.json({ 
            success: false, 
            message: 'သင်သည် ယနေ့အတွက် Report တင်ပြီးဖြစ်ပါသည်။ မနက်ဖြန်မှ ပြန်လည်တင်ပြနိုင်ပါမည်။' 
        });
    }

    const reportMessage = `🚨 *ISP Report အသစ်ရောက်ရှိပါသည်* 🚨\n\n` +
                          `👤 *Customer Name:* ${customerName}\n` +
                          `🆔 *Customer ID:* ${customerId.toUpperCase()}\n` +
                          `📦 *FAT/Zone:* ${currentFatBox}\n` +
                          `⚠️ *Issue:* ${issue}\n` +
                          `⏰ *Time:* ${new Date().toLocaleString('en-US', { timeZone: 'Asia/Yangon' })}`;

    try {
        await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
            chat_id: TELEGRAM_CHAT_ID,
            text: reportMessage,
            parse_mode: 'Markdown'
        });

        customerLastReportTime[formattedId] = todayDate;

        if (issue.includes('မီးနီ')) {
            if (!fatRedLightReports[currentFatBox]) {
                fatRedLightReports[currentFatBox] = [];
            }

            const oneHourAgo = now - 60 * 60 * 1000;
            fatRedLightReports[currentFatBox] = fatRedLightReports[currentFatBox].filter(timestamp => timestamp > oneHourAgo);
            fatRedLightReports[currentFatBox].push(now);

            if (fatRedLightReports[currentFatBox].length >= 3) {
                const warningMessage = `⚠️ *FAT BOX WARNING ALERT!* ⚠️\n\n` +
                                       `📍 *FAT/Zone Name:* ${currentFatBox}\n` +
                                       `⚡ *Status:* ၁ နာရီအတွင်း မီးနီ Report (${fatRedLightReports[currentFatBox].length}) ခု ဝင်ရောက်ထားပါသည်။\n` +
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
