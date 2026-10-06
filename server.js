const express = require('express');
const axios = require('axios');
const app = express();
const PORT = process.env.PORT || 3000;

// Express Server Rendering settings
app.set('trust proxy', 1);
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

// 🛡️ IP Rate Limiting (Phone တစ်လုံးတည်းမှ Spam မရအောင် တားဆီးခြင်း)
const ipReportTracker = {};
const SPAM_WINDOW_MS = 15 * 60 * 1000; // ၁၅ မိနစ်
const MAX_REPORTS_PER_IP = 3;         // ၁၅ မိနစ်အတွင်း အများဆုံး ၃ ကြိမ်သာ ရမည်

let onuCache = [];
let lastCacheTime = 0;
const CACHE_DURATION = 10 * 60 * 1000;

function getDomainUrl() {
    if (!SMARTOLT_DOMAIN) return '';
    return SMARTOLT_DOMAIN.includes('.') 
        ? `https://${SMARTOLT_DOMAIN}`
        : `https://${SMARTOLT_DOMAIN}.smartolt.com`;
}

async function refreshOnuCache() {
    if (!SMARTOLT_DOMAIN || !SMARTOLT_API_KEY) return;
    const now = Date.now();
    if (onuCache.length > 0 && (now - lastCacheTime < CACHE_DURATION)) {
        return;
    }

    const domainUrl = getDomainUrl();

    try {
        console.log('🔄 Fetching ONUs from SmartOLT...');
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

function extractSignalValue(onu) {
    if (!onu) return 'N/A';

    const possibleFields = [
        onu.signal_1310,
        onu.signal_1490,
        onu.snmp_signal,
        onu.onu_signal_value,
        onu.signal,
        onu.rx_power,
        onu.onu_rx_power
    ];

    for (let val of possibleFields) {
        if (val !== undefined && val !== null && val !== '') {
            let strVal = val.toString().trim();
            if (strVal.match(/-?\d+(\.\d+)?/)) {
                return strVal;
            }
        }
    }

    return 'N/A';
}

async function getExactSignalDbmApi(onuExternalId) {
    if (!onuExternalId || !SMARTOLT_DOMAIN || !SMARTOLT_API_KEY) return 'N/A';
    const domainUrl = getDomainUrl();

    try {
        const res = await axios.get(`${domainUrl}/api/onu/get_onu_signal/${onuExternalId}`, {
            headers: { 'X-Token': SMARTOLT_API_KEY },
            timeout: 8000
        });

        if (res.data) {
            const sig = res.data.signal || res.data.onu_signal || res.data.snmp_signal || 
                        (res.data.response ? (res.data.response.rx_power || res.data.response.signal) : null);
            
            if (sig) {
                let strSig = sig.toString().trim();
                if (strSig.match(/-?\d+(\.\d+)?/)) {
                    return strSig;
                }
            }
        }
    } catch (err) {
        console.log('⚠️ Signal Fetch Error:', err.message);
    }
    
    return 'N/A';
}

// 🔍 SmartOLT Lookup Endpoint
app.get('/api/get-customer/:id', async (req, res) => {
    const searchKey = req.params.id.trim().toUpperCase();

    if (!SMARTOLT_DOMAIN || !SMARTOLT_API_KEY) {
        return res.json({ 
            success: false, 
            message: 'Server Config Error: SmartOLT Domain/API Key မရှိပါ' 
        });
    }

    await refreshOnuCache();

    if (onuCache.length === 0) {
        return res.json({ 
            success: false, 
            message: 'SmartOLT Data မရရှိသေးပါ (ခဏစောင့်ပြီး ပြန်စမ်းပါ)' 
        });
    }

    const matchedOnu = onuCache.find(onu => {
        const customId = (onu.custom_id || '').toUpperCase();
        const name = (onu.name || '').toUpperCase();
        const sn = (onu.sn || '').toUpperCase();
        const extId = (onu.unique_external_id || '').toUpperCase();
        const numOnly = searchKey.replace(/\D/g, '');

        return customId === searchKey || 
               name.includes(searchKey) || 
               sn === searchKey || 
               extId === searchKey ||
               (numOnly.length > 0 && customId.includes(numOnly)) ||
               (numOnly.length > 0 && name.includes(numOnly));
    });

    if (matchedOnu) {
        const exactFatBox = matchedOnu.odb_name || matchedOnu.address || matchedOnu.zone_name || matchedOnu.olt_name || 'Unknown-FAT';
        const status = matchedOnu.status || 'Unknown';
        
        let signalValue = extractSignalValue(matchedOnu);

        if (signalValue === 'N/A') {
            const extId = matchedOnu.unique_external_id || matchedOnu.id || matchedOnu.sn;
            signalValue = await getExactSignalDbmApi(extId);
        }

        return res.json({
            success: true,
            username: matchedOnu.name || matchedOnu.custom_id || matchedOnu.sn,
            fatBox: exactFatBox,
            onuStatus: status,
            signal: signalValue
        });
    }

    res.json({ 
        success: false, 
        message: `SmartOLT ထဲတွင် '${req.params.id}' အား မတွေ့ရှိပါ` 
    });
});

// 📩 Report Submit Endpoint (Spam-Protected)
app.post('/api/submit-report', async (req, res) => {
    const { customerId, customerName, issue, fatBox, onuStatus, signal } = req.body;
    const formattedId = customerId.trim().toLowerCase();
    const now = Date.now();
    const todayDate = new Date().toDateString();

    // 🛑 1. Device IP Address ကို စစ်ဆေးခြင်း
    const userIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown-ip';

    if (!ipReportTracker[userIp]) {
        ipReportTracker[userIp] = [];
    }

    // ၁၅ မိနစ်ကျော်သွားသော Record များကို ရှင်းထုတ်ခြင်း
    ipReportTracker[userIp] = ipReportTracker[userIp].filter(timestamp => (now - timestamp) < SPAM_WINDOW_MS);

    // IP တစ်ခုတည်းမှ ၁၅ မိနစ်အတွင်း ၃ ကြိမ်ထက်ပိုလျှင် ပိတ်ဆို့ခြင်း
    if (ipReportTracker[userIp].length >= MAX_REPORTS_PER_IP) {
        return res.json({
            success: false,
            message: '⚠️ သင်သည် တိုတောင်းသော အချိန်အတွင်း Report အများအပြား ပေးပို့ထားပါသည်။ ခဏစောင့်ပြီးမှ ပြန်လည်စမ်းသပ်ပါနော်။'
        });
    }

    // 🛑 2. Customer ID တစ်ခုတည်းအတွက် နေ့စဉ် ၁ ကြိမ်စစ်ဆေးခြင်း
    if (customerLastReportTime[formattedId] === todayDate) {
        return res.json({ 
            success: false, 
            message: 'ဒီ Customer ID အတွက် ယနေ့ Report တင်ပြီးဖြစ်ပါသည်။ မနက်ဖြန်မှ ပြန်လည်တင်ပြနိုင်ပါမည်။' 
        });
    }

    const currentFatBox = fatBox || 'Unknown-FAT';
    const currentStatus = onuStatus || 'N/A';
    
    let formattedSignal = 'N/A';
    if (signal && signal !== 'N/A') {
        const cleanSig = signal.replace(/dBm/gi, '').trim();
        if (cleanSig && cleanSig !== '-') {
            formattedSignal = `${cleanSig} dBm`;
        }
    }

    const reportMessage = `🚨 *ISP Report အသစ်ရောက်ရှိပါသည်* 🚨\n\n` +
                          `👤 *Customer Name:* ${customerName}\n` +
                          `🆔 *Customer ID:* ${customerId.toUpperCase()}\n` +
                          `📦 *FAT Box:* ${currentFatBox}\n` +
                          `📡 *SmartOLT Status:* ${currentStatus}\n` +
                          `📶 *Signal Power:* ${formattedSignal}\n` +
                          `⚠️ *Issue:* ${issue}\n` +
                          `⏰ *Time:* ${new Date().toLocaleString('en-US', { timeZone: 'Asia/Yangon' })}`;

    try {
        await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
            chat_id: TELEGRAM_CHAT_ID,
            text: reportMessage,
            parse_mode: 'Markdown'
        });

        // Report တင်ပြီးပါက IP Tracker နှင့် Customer ID History ကို Update လုပ်မည်
        ipReportTracker[userIp].push(now);
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
                                       `📍 *FAT Box:* ${currentFatBox}\n` +
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
