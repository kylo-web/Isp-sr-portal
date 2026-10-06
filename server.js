const express = require('express');
const axios = require('axios');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static('public'));

// 🔑 Telegram & SmartOLT Environment Configs
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';

let domainInput = process.env.SMARTOLT_DOMAIN || '';
domainInput = domainInput.replace(/^https?:\/\//, '').replace(/\/$/, '');

const SMARTOLT_DOMAIN = domainInput;
const SMARTOLT_API_KEY = process.env.SMARTOLT_API_KEY || '';

const customerLastReportTime = {};
const fatRedLightReports = {};

// Customer ID ပုံစံအမျိုးမျိုး ထုတ်ပေးရန် (tty00001, TTY00001, tty1, 1)
function generatePossibleIDs(rawId) {
    const cleaned = rawId.trim();
    const match = cleaned.match(/^([a-zA-Z]+)?(\d+)$/);

    if (!match) return [cleaned.toUpperCase()];

    const prefix = (match[1] || 'TTY').toUpperCase();
    const numStr = match[2];
    const num = parseInt(numStr, 10);

    const ids = new Set();
    ids.add(cleaned.toUpperCase());
    ids.add(`${prefix}${num}`);
    ids.add(`${prefix}${String(num).padStart(3, '0')}`);
    ids.add(`${prefix}${String(num).padStart(4, '0')}`);
    ids.add(`${prefix}${String(num).padStart(5, '0')}`);
    ids.add(String(num));

    return Array.from(ids);
}

// 🔍 SmartOLT API Customer Lookup
app.get('/api/get-customer/:id', async (req, res) => {
    const rawId = req.params.id.trim();
    const possibleIds = generatePossibleIDs(rawId);

    if (!SMARTOLT_DOMAIN || !SMARTOLT_API_KEY) {
        console.error('SmartOLT Config Missing!');
        return res.json({ success: false, message: 'SmartOLT API အချက်အလက် မပြည့်စုံပါ' });
    }

    const domainUrl = SMARTOLT_DOMAIN.includes('.') 
        ? `https://${SMARTOLT_DOMAIN}`
        : `https://${SMARTOLT_DOMAIN}.smartolt.com`;

    try {
        let foundOnu = null;

        // နည်းလမ်း (၁) - ONUs အားလုံးကို ဆွဲယူပြီး တိကျစွာ တိုက်ဆိုင်စစ်ဆေးခြင်း
        try {
            const listUrl = `${domainUrl}/api/onu/get_all_onus_details`;
            const response = await axios.get(listUrl, {
                headers: { 
                    'X-Token': SMARTOLT_API_KEY,
                    'Accept': 'application/json'
                },
                timeout: 10000
            });

            if (response.data && response.data.onus && Array.isArray(response.data.onus)) {
                const allOnus = response.data.onus;
                foundOnu = allOnus.find(onu => {
                    const cId = (onu.custom_id || '').toUpperCase();
                    const name = (onu.name || '').toUpperCase();
                    const sn = (onu.sn || '').toUpperCase();
                    return possibleIds.some(pId => cId === pId || name.includes(pId) || sn === pId);
                });
            }
        } catch (e) {
            console.log('Method 1 search failed, trying method 2:', e.message);
        }

        // နည်းလမ်း (၂) - Direct Custom ID Endpoint ဖြင့် ရှာဖွေခြင်း
        if (!foundOnu) {
            for (const searchId of possibleIds) {
                try {
                    const directUrl = `${domainUrl}/api/onu/get_onu_details_by_custom_id/${encodeURIComponent(searchId)}`;
                    const response = await axios.get(directUrl, {
                        headers: { 'X-Token': SMARTOLT_API_KEY },
                        timeout: 5000
                    });

                    if (response.data && response.data.status === true && response.data.onu_details) {
                        foundOnu = response.data.onu_details;
                        break;
                    }
                } catch (err) {
                    continue;
                }
            }
        }

        if (foundOnu) {
            return res.json({
                success: true,
                username: foundOnu.name || foundOnu.custom_id,
                fatBox: foundOnu.zone_name || foundOnu.odb_name || foundOnu.address || 'Unknown-FAT'
            });
        }

        res.json({ success: false, message: 'SmartOLT ထဲတွင် Customer ID မတွေ့ရှိပါ' });

    } catch (error) {
        console.error('SmartOLT General Error:', error.message);
        res.json({ success: false, message: 'SmartOLT ချိတ်ဆက်မှု အဆင်မပြေပါ' });
    }
});

// 📩 Report Submit API
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
        console.error('Telegram Error:', error.message);
        res.json({ success: false, message: 'Telegram Noti ပို့ရာတွင် အမှားရှိပါသည်' });
    }
});

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
