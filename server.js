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

// 🧠 SmartOLT Cache Memory (၁၀ မိနစ်တစ်ကြိမ် Sync လုပ်မည်)
let onuCache = [];
let lastCacheTime = 0;
const CACHE_DURATION = 10 * 60 * 1000; // 10 minutes

async function refreshOnuCache() {
    if (!SMARTOLT_DOMAIN || !SMARTOLT_API_KEY) return;
    const now = Date.now();
    if (onuCache.length > 0 && (now - lastCacheTime < CACHE_DURATION)) {
        return; // Cache သက်တမ်း မကုန်သေးပါက ထပ်မဆွဲပါ
    }

    const domainUrl = SMARTOLT_DOMAIN.includes('.') 
        ? `https://${SMARTOLT_DOMAIN}`
        : `https://${SMARTOLT_DOMAIN}.smartolt.com`;

    try {
        console.log('🔄 Fetching ONUs list from SmartOLT...');
        const response = await axios.get(`${domainUrl}/api/onu/get_all_onus_details`, {
            headers: { 'X-Token': SMARTOLT_API_KEY },
            timeout: 15000
        });

        if (response.data && response.data.onus && Array.isArray(response.data.onus)) {
            onuCache = response.data.onus;
            lastCacheTime = now;
            console.log(`✅ Loaded ${onuCache.length} ONUs into memory cache!`);
        }
    } catch (err) {
        console.error('❌ Cache Fetch Error:', err.message);
    }
}

// 🔍 Fast Local Cache Search Endpoint (၁၀၀% သေချာသော နည်းလမ်း)
app.get('/api/get-customer/:id', async (req, res) => {
    const searchKey = req.params.id.trim().toUpperCase();

    if (!SMARTOLT_DOMAIN || !SMARTOLT_API_KEY) {
        return res.json({ 
            success: false, 
            message: 'Server Config Error: SmartOLT Domain/API Key မရှိပါ' 
        });
    }

    // Cache Refresh စစ်မည်
    await refreshOnuCache();

    if (onuCache.length === 0) {
        return res.json({ 
            success: false, 
            message: 'SmartOLT Data ချိတ်ဆက်၍ မရသေးပါ (ခဏစောင့်ပြီး ပြန်စမ်းပါ)' 
        });
    }

    // စာလုံးအထဲပါမပါ တိုက်ရိုက် Flex Search လုပ်မည် (ID / Custom ID / Name / Serial Number / External ID)
    const matchedOnu = onuCache.find(onu => {
        const customId = (onu.custom_id || '').toUpperCase();
        const name = (onu.name || '').toUpperCase();
        const sn = (onu.sn || '').toUpperCase();
        const extId = (onu.unique_external_id || '').toUpperCase();

        // ဥပမာ TTY01072 ဆိုရင် 01072 သို့ 1072 ပါရင်ပါ သေချာအောင် နံပါတ်ချည်းသီးသန့်ပါ စစ်ပေးသည်
        const numOnly = searchKey.replace(/\D/g, '');

        return customId === searchKey || 
               name.includes(searchKey) || 
               sn === searchKey || 
               extId === searchKey ||
               (numOnly.length > 0 && customId.includes(numOnly)) ||
               (numOnly.length > 0 && name.includes(numOnly));
    });

    if (matchedOnu) {
        return res.json({
            success: true,
            username: matchedOnu.name || matchedOnu.custom_id || matchedOnu.sn,
            fatBox: matchedOnu.zone_name || matchedOnu.odb_name || matchedOnu.address || 'Unknown-FAT'
        });
    }

    res.json({ 
        success: false, 
        message: `SmartOLT ထဲတွင် '${req.params.id}' အား မတွေ့ရှိပါ` 
    });
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
