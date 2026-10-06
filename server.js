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
// DOMAIN တွင် 'https://' မပါရပါ (ဥပမာ: 'mycompany.smartolt.com' သို့မဟုတ် 'mycompany')
const SMARTOLT_DOMAIN = 'infinet-mm.smartolt.com'.replace(/^https?:\/\//, '').replace(/\/$/, '');
const SMARTOLT_API_KEY = 'accea08359014b738df318ae274218e3';

const customerLastReportTime = {};
const fatRedLightReports = {};

// ID Format အစုံ ထုတ်ပေးသည့် Function (tty797 -> TTY00797, TTY0797, TTY797)
function generatePossibleIDs(rawId) {
    const cleaned = rawId.trim();
    const match = cleaned.match(/^([a-zA-Z]+)?(\d+)$/);

    if (!match) return [cleaned.toUpperCase()];

    const prefix = (match[1] || 'TTY').toUpperCase();
    const num = parseInt(match[2], 10);

    const ids = new Set();
    ids.add(cleaned.toUpperCase());
    ids.add(`${prefix}${num}`);
    ids.add(`${prefix}${String(num).padStart(3, '0')}`);
    ids.add(`${prefix}${String(num).padStart(4, '0')}`);
    ids.add(`${prefix}${String(num).padStart(5, '0')}`);

    return Array.from(ids);
}

// SmartOLT API မှ Customer ရှာဖွေခြင်း (Direct Custom ID Endpoint)
app.get('/api/get-customer/:id', async (req, res) => {
    const rawId = req.params.id.trim();
    const possibleIds = generatePossibleIDs(rawId);

    const domainUrl = SMARTOLT_DOMAIN.includes('.') 
        ? `https://${SMARTOLT_DOMAIN}`
        : `https://${SMARTOLT_DOMAIN}.smartolt.com`;

    try {
        let foundOnu = null;

        // ID Format တစ်ခုချင်းစီဖြင့် SmartOLT သို့ တိုက်ရိုက် တောင်းကြည့်မည်
        for (const searchId of possibleIds) {
            try {
                // SmartOLT Custom ID Direct Search Endpoint
                const apiUrl = `${domainUrl}/api/onu/get_onu_details_by_custom_id/${encodeURIComponent(searchId)}`;
                
                const response = await axios.get(apiUrl, {
                    headers: { 
                        'X-Token': SMARTOLT_API_KEY,
                        'Accept': 'application/json'
                    },
                    timeout: 5000
                });

                if (response.data && response.data.status === true && response.data.onu_details) {
                    foundOnu = response.data.onu_details;
                    break; // တွေ့ရှိပါက Loop မှ ထွက်မည်
                }
            } catch (err) {
                // Single ID search 404/Error ဖြစ်ပါက နောက်တစ်မျိုး ဆက်ရှာမည်
                continue;
            }
        }

        // Direct Search နဲ့ မတွေ့ပါက Search API သို့ မေးကြည့်မည်
        if (!foundOnu) {
            try {
                const searchUrl = `${domainUrl}/api/onu/get_all_onus_details`;
                const response = await axios.get(searchUrl, {
                    headers: { 'X-Token': SMARTOLT_API_KEY },
                    params: { custom_id: possibleIds[0] },
                    timeout: 7000
                });

                if (response.data && response.data.onus && response.data.onus.length > 0) {
                    const allOnus = response.data.onus;
                    foundOnu = allOnus.find(o => possibleIds.some(pId => (o.custom_id || '').toUpperCase() === pId)) || allOnus[0];
                }
            } catch (e) {
                console.error('Fallback search error:', e.message);
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
