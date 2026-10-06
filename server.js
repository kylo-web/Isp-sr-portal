const express = require('express');
const axios = require('axios');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static('public'));

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';

let rawDomain = process.env.SMARTOLT_DOMAIN || '';
rawDomain = rawDomain.replace(/^https?:\/\//, '').replace(/\/$/, '');

const SMARTOLT_DOMAIN = rawDomain;
const SMARTOLT_API_KEY = process.env.SMARTOLT_API_KEY || '';

const customerLastReportTime = {};
const fatRedLightReports = {};

// Customer ID ပုံစံအမျိုးမျိုး စမ်းသပ်ရန်
function generatePossibleIDs(rawId) {
    const cleaned = rawId.trim();
    const match = cleaned.match(/^([a-zA-Z]+)?(\d+)$/);

    if (!match) return [cleaned.toUpperCase(), cleaned.toLowerCase()];

    const prefix = (match[1] || 'TTY').toUpperCase();
    const num = parseInt(match[2], 10);

    const ids = new Set();
    ids.add(cleaned.toUpperCase());
    ids.add(cleaned.toLowerCase());
    ids.add(`${prefix}${num}`);
    ids.add(`${prefix}${String(num).padStart(3, '0')}`);
    ids.add(`${prefix}${String(num).padStart(4, '0')}`);
    ids.add(`${prefix}${String(num).padStart(5, '0')}`);

    return Array.from(ids);
}

// 🔍 SmartOLT API Customer Lookup (Optimized for 429 Error Fix)
app.get('/api/get-customer/:id', async (req, res) => {
    const rawId = req.params.id.trim();
    const possibleIds = generatePossibleIDs(rawId);

    if (!SMARTOLT_DOMAIN || !SMARTOLT_API_KEY) {
        return res.json({ 
            success: false, 
            message: 'Server Config Error: SmartOLT Domain/API Key မရှိပါ' 
        });
    }

    const domainUrl = SMARTOLT_DOMAIN.includes('.') 
        ? `https://${SMARTOLT_DOMAIN}`
        : `https://${SMARTOLT_DOMAIN}.smartolt.com`;

    let foundOnu = null;

    // Direct Customer ID Endpoint ဖြင့်သာ ကွက်တိ တိုက်ရိုက် ရှာဖွေမည်
    for (const searchId of possibleIds) {
        try {
            const directUrl = `${domainUrl}/api/onu/get_onu_details_by_custom_id/${encodeURIComponent(searchId)}`;
            const response = await axios.get(directUrl, {
                headers: { 'X-Token': SMARTOLT_API_KEY },
                timeout: 5000
            });

            if (response.data && response.data.status === true && response.data.onu_details) {
                foundOnu = response.data.onu_details;
                break; // တွေ့ရင် Loop ကို ရပ်မည်
            }
        } catch (err) {
            if (err.response && err.response.status === 429) {
                console.error('SmartOLT Rate Limit Hit (429)');
                return res.json({ 
                    success: false, 
                    message: 'SmartOLT Server ခေတ္တ မအားပါ (Rate Limit - 429)။ မိနစ်နည်းနည်းစောင့်ပြီး ပြန်စမ်းပါ။' 
                });
            }
            continue;
        }
    }

    if (foundOnu) {
        return res.json({
            success: true,
            username: foundOnu.name || foundOnu.custom_id,
            fatBox: foundOnu.zone_name || foundOnu.odb_name || foundOnu.address || 'Unknown-FAT'
        });
    }

    res.json({ success: false, message: `SmartOLT ထဲတွင် '${rawId}' အား မတွေ့ရှိပါ` });
});

// Report Submit Endpoint
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
