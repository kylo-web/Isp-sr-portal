const express = require('express');
const axios = require('axios');
const app = express();

app.use(express.json());
app.use(express.static('public'));

// SmartOLT Configuration
const SMARTOLT_URL = 'https://<your-subdomain>.smartolt.com/api';
const SMARTOLT_API_KEY = 'YOUR_SMARTOLT_API_KEY';

// Telegram Configuration
const TELEGRAM_BOT_TOKEN = '8262489446:AAE1YGOaU7gIOp...'; // သင့် Bot Token ပြန်ထည့်ပါ
const TELEGRAM_CHAT_ID = '-1004295109530'; // သင့် Chat ID ပြန်ထည့်ပါ

// Memory Cache ထဲတွင် Rate Limit နှင့် FAT Tracker မှတ်ထားရန် Variable များ
const userReportHistory = {}; // { customerId: timestamp }
const fatBoxReports = {};     // { fatBoxName: [ { customerId, timestamp } ] }

app.post('/api/report-issue', async (req, res) => {
    const { customerId, issue, newPassword } = req.body;
    const now = Date.now();
    
    // အချိန် သတ်မှတ်ချက်များ (Miliseconds)
    const ONE_DAY_MS = 24 * 60 * 60 * 1000; // Customer ID တစ်ခုအတွက် (၂၄ နာရီ)
    const ONE_HOUR_MS = 1 * 60 * 60 * 1000; // FAT Box စစ်ဆေးရန်အတွက် (၁ နာရီ)

    // ၁။ Customer ID တစ်ခုကို တစ်ရက် (၂၄ နာရီ) လျှင် ၁ ကြိမ်သာ တင်ခွင့်ပြုရန် စစ်ဆေးခြင်း
    if (userReportHistory[customerId]) {
        const lastReportTime = userReportHistory[customerId];
        if (now - lastReportTime < ONE_DAY_MS) {
            return res.status(429).json({ 
                success: false, 
                message: 'လူကြီးမင်းသည် ယနေ့အတွက် Report တင်ပြီးဖြစ်ပါသည်။ (၁ ရက်လျှင် ၁ ကြိမ်သာ တင်ခွင့်ရှိပါသည်)' 
            });
        }
    }

    let customerName = "မဖော်ပြထားပါ";
    let phoneNumber = "မဖော်ပြထားပါ";
    let fatBox = "FAT-A03 / Main Road"; // Default Test FAT Box
    let locationText = "[Google Maps ကြည့်ရန်](https://maps.google.com/?q=16.8661,96.1951)";
    let onuStatusInfo = `
📶 **ONU Status:** Online
💡 **Optical Signal (Rx):** -19.50 dBm
🏢 **OLT / Board / Port:** OLT-01 (Port: 1/2/4)
🏷 **SN / MAC:** HWTC12345678`;

    // SmartOLT API ချိတ်ဆက်ထားပါက အချက်အလက်ယူခြင်း
    try {
        const smartOltRes = await axios.get(`${SMARTOLT_URL}/onu/get_onus_details_by_custom_id/${customerId}`, {
            headers: { 'X-Token': SMARTOLT_API_KEY }
        });

        if (smartOltRes.data && smartOltRes.data.onus && smartOltRes.data.onus.length > 0) {
            const onu = smartOltRes.data.onus[0];
            if (onu.name) customerName = onu.name;
            if (onu.phone) phoneNumber = onu.phone;
            if (onu.zone_name || onu.address) fatBox = onu.zone_name || onu.address;
            
            if (onu.latitude && onu.longitude) {
                locationText = `[Google Maps ကြည့်ရန်](https://maps.google.com/?q=${onu.latitude},${onu.longitude})`;
            }
            onuStatusInfo = `
📶 **ONU Status:** ${onu.status}
💡 **Optical Signal (Rx):** ${onu.signal || 'N/A'} dBm
🏢 **OLT / Board / Port:** ${onu.olt_name || 'N/A'} (Port: ${onu.board}/${onu.port})
🏷 **SN / MAC:** ${onu.sn}`;
        }
    } catch (error) {
        console.log("SmartOLT API Fetching Skipped / Not Configured");
    }

    // ၂။ FAT Box တစ်ခုထဲမှ တိုင်ကြားချက်များကို "၁ နာရီအတွင်း" ဖြစ်မဖြစ် စစ်ဆေးခြင်း
    if (!fatBoxReports[fatBox]) {
        fatBoxReports[fatBox] = [];
    }
    
    // ၁ နာရီ (60 မိနစ်) ကျော်သွားသော အဟောင်းများကို စာရင်းမှ ဖျက်ထုတ်ခြင်း
    fatBoxReports[fatBox] = fatBoxReports[fatBox].filter(item => (now - item.timestamp) < ONE_HOUR_MS);
    
    // ID မတူသေးပါက FAT Tracker ထဲသို့ အသစ်ထည့်ခြင်း
    if (!fatBoxReports[fatBox].some(item => item.customerId === customerId)) {
        fatBoxReports[fatBox].push({ customerId, timestamp: now });
    }

    // Password change ပြင်ဆင်မှု
    let passwordText = "";
    if (newPassword) {
        passwordText = `\n🔑 **Password အသစ်:** \`${newPassword}\``;
    }

    // Telegram စာသား ဖန်တီးခြင်း
    const telegramMessage = `
🚨 **CUSTOMER TROUBLESHOOT REPORT**
━━━━━━━━━━━━━━━━━━
🆔 **User ID:** \`${customerId}\`
👤 **Username:** ${customerName}
📞 **Phone Number:** ${phoneNumber}
📦 **FAT Box:** ${fatBox}
📍 **Location:** ${locationText}

⚠️ **ကြုံတွေ့နေရသည့် ပြဿနာ:** **${issue}**${passwordText}

🌐 **SmartOLT Live Status:**
${onuStatusInfo}
━━━━━━━━━━━━━━━━━━
⏰ **Time:** ${new Date().toLocaleString('en-US', { timeZone: 'Asia/Yangon' })}
`;

    try {
        // Customer ရဲ့ Report ကို Telegram သို့ ပို့ခြင်း
        await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
            chat_id: TELEGRAM_CHAT_ID,
            text: telegramMessage,
            parse_mode: 'Markdown',
            disable_web_page_preview: false
        });

        // ၃။ ၁ နာရီအတွင်း FAT Box တစ်ခုထဲမှ Report ပို့သူ ၃ ဦးထက် ပိုပါက (၄ ဦးနှင့်အထက်ဖြစ်ပါက) အရေးပေါ် Noti ပို့ခြင်း
        if (fatBoxReports[fatBox].length > 3) {
            const alertMessage = `
⚠️ **WARNING: FAT BOX ISSUE / LINK DOWN DETECTED**
━━━━━━━━━━━━━━━━━━
📦 **FAT Box:** \`${fatBox}\`
🚨 **အခြေအနေ:** ထို FAT Box အောက်မှ Customer **${fatBoxReports[fatBox].length} ဦး** မှ (၁) နာရီအတွင်း တိုင်ကြားထားပါသည်။
⚡ **FAT Link ကျနေခြင်း သို့မဟုတ် ပင်မလိုင်း ပြတ်တောက်နေခြင်း ဖြစ်နိုင်ပါသဖြင့် အမြန်ဆုံး စစ်ဆေးပေးပါ။**
━━━━━━━━━━━━━━━━━━`;

            await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
                chat_id: TELEGRAM_CHAT_ID,
                text: alertMessage,
                parse_mode: 'Markdown'
            });
        }

        // အောင်မြင်စွာ ပို့ပြီးကြောင်း တင်ထားသည့် စာရင်းမှတ်ထားခြင်း
        userReportHistory[customerId] = now;

        return res.json({ success: true, message: 'သတင်းပို့ချက် အောင်မြင်စွာ ပို့ပြီးပါပြီ။' });
    } catch (err) {
        console.error(err);
        return res.status(500).json({ success: false, message: 'Telegram Noti ပို့ရာတွင် အမှားအယွင်းရှိပါသည်။' });
    }
});

app.listen(3000, () => console.log('Server is running on port 3000'));








































