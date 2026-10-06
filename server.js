const express = require('express');
const axios = require('axios');
const app = express();
const PORT = process.env.PORT || 3000;

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

const ipReportTracker = {};
const SPAM_WINDOW_MS = 15 * 60 * 1000; 
const MAX_REPORTS_PER_IP = 3;         

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
        const exactFatBox = matchedOnu.odb_name || matchedOnu.zone_name || matchedOnu.olt_name || 'Unknown-FAT';
        const address = matchedOnu.address || matchedOnu.location || 'N/A';
        const status = matchedOnu.status || 'Unknown';
        
        let signalValue = extractSignalValue(matchedOnu);

        if (signalValue === 'N/A') {
            const extId = matchedOnu.unique_external_id || matchedOnu.id || matchedOnu.sn;
            signalValue = await getExactSignalDbmApi(extId);
        }

        return res.json({
            success: true,
            username: matchedOnu.name || matchedOnu.custom_id || matchedOnu.sn,
            address: address,
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

app.post('/api/submit-report', async (req, res) => {
    const { customerId, customerName, address, issue, fatBox, onuStatus, signal } = req.body;
    const formattedId = customerId.trim().toLowerCase();
    const now = Date.now();
    const todayDate = new Date().toDateString();

    const userIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown-ip';

    if (!ipReportTracker[userIp]) {
        ipReportTracker[userIp] = [];
    }

    ipReportTracker[userIp] = ipReportTracker[userIp].filter(timestamp => (now - timestamp) < SPAM_WINDOW_MS);

    if (ipReportTracker[userIp].length >= MAX_REPORTS_PER_IP) {
        return res.json({
            success: false,
            message: '⚠️ သင်သည် တိုတောင်းသော အချိန်အတွင်း Report အများအပြား ပေးပို့ထားပါသည်။ ခဏစောင့်ပြီးမှ ပြန်လည်စမ်းသပ်ပါနော်။'
        });
    }

    if (customerLastReportTime[formattedId] === todayDate) {
        return res.json({ 
            success: false, 
            message: 'ဒီ Customer ID အတွက် ယနေ့ Report တင်ပြီးဖြစ်ပါသည်။ မနက်ဖြန်မှ ပြန်လည်တင်ပြနိုင်ပါမည်။' 
        });
    }

    const currentFatBox = fatBox || 'Unknown-FAT';
    const currentStatus = onuStatus || 'N/A';
    const currentAddress = address || 'N/A';
    
    let formattedSignal = 'N/A';
    if (signal && signal !== 'N/A') {
        const cleanSig = signal.replace(/dBm/gi, '').trim();
        if (cleanSig && cleanSig !== '-') {
cat << 'EOF' > public/index.html
<!DOCTYPE html>
<html lang="my">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>ISP Customer Support</title>
    <style>
        * {
            box-sizing: border-box;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
        }
        body {
            background-color: #121212;
            color: #ffffff;
            margin: 0;
            padding: 20px;
            display: flex;
            justify-content: center;
            align-items: flex-start;
            min-height: 100vh;
        }
        .container {
            width: 100%;
            max-width: 400px;
            background-color: #1e1e1e;
            padding: 24px;
            border-radius: 16px;
            box-shadow: 0 8px 24px rgba(0,0,0,0.5);
        }
        h2 {
            text-align: center;
            color: #4caf50;
            margin-top: 0;
            margin-bottom: 24px;
            font-size: 22px;
        }
        label {
            display: block;
            margin-bottom: 8px;
            font-weight: 600;
            font-size: 15px;
        }
        input, select, textarea {
            width: 100%;
            padding: 12px 14px;
            border-radius: 8px;
            border: 1px solid #444;
            background-color: #2a2a2a;
            color: #fff;
            font-size: 15px;
            margin-bottom: 16px;
            outline: none;
        }
        input::placeholder {
            color: #777;
        }
        input:focus, select:focus, textarea:focus {
            border-color: #4caf50;
        }
        .btn {
            width: 100%;
            padding: 12px;
            border-radius: 8px;
            border: none;
            background-color: #4caf50;
            color: #ffffff;
            font-size: 16px;
            font-weight: bold;
            cursor: pointer;
            transition: background 0.2s;
        }
        .btn:hover {
            background-color: #45a049;
        }
        .issue-btn {
            width: 100%;
            padding: 14px;
            border-radius: 10px;
            border: 1px solid #333;
            background-color: #2a2a2a;
            color: #ffffff;
            font-size: 15px;
            text-align: left;
            margin-bottom: 10px;
            cursor: pointer;
            display: flex;
            align-items: center;
        }
        .issue-btn:hover {
            background-color: #333;
        }
        .issue-btn.selected {
            border-color: #4caf50;
            background-color: #223a24;
        }
        .info-box {
            background: #282828;
            padding: 12px 16px;
            border-radius: 10px;
            margin-bottom: 20px;
            border-left: 4px solid #4caf50;
        }
        .info-box p {
            margin: 6px 0;
            font-size: 14px;
            color: #ddd;
        }
        .hidden {
            display: none !important;
        }
    </style>
</head>
<body>

<div class="container">
    <h2>ISP Customer Support</h2>

    <!-- Step 1: Customer Search -->
    <div id="searchSection">
        <label for="customerId">Customer ID ရိုက်ထည့်ပါ:</label>
        <input type="text" id="customerId" placeholder="Eg. TTY01072 သို့မဟုတ် 1072">
        <button type="button" class="btn" id="searchBtn">စစ်ဆေးမည်</button>
    </div>

    <!-- Loading Indicator -->
    <div id="loading" class="hidden" style="text-align: center; padding: 20px 0;">
        <p style="color: #4caf50;">⏳ အချက်အလက်များ စစ်ဆေးနေပါသည်...</p>
    </div>

    <!-- Step 2: Customer Details & Issue Buttons -->
    <div id="reportSection" class="hidden">
        <div class="info-box">
            <p>👤 <b>Name:</b> <span id="dispName">-</span></p>
            <p>🆔 <b>Customer ID:</b> <span id="dispId">-</span></p>
            <p>🏠 <b>Address:</b> <span id="dispAddress">-</span></p>
            <p>📦 <b>FAT Box:</b> <span id="dispFat">-</span></p>
            <p>📡 <b>Status:</b> <span id="dispStatus">-</span></p>
            <p>📶 <b>Signal Power:</b> <span id="dispSignal">-</span></p>
        </div>

        <label>ဖြစ်ပေါ်နေသော ပြဿနာအား ရွေးပါ:</label>

        <!-- ပြဿနာ Options ၆ မျိုး -->
        <button type="button" class="issue-btn" data-issue="LOS / မီးနီ 🔴">
            🔴 LOS / မီးနီ
        </button>

        <button type="button" class="issue-btn" data-issue="လိုင်းနှေး 🐢">
            🐢 လိုင်းနှေး
        </button>

        <button type="button" class="issue-btn" data-issue="PON မီးခုန် / မီးသုံးလုံးလင်းပြီး လိုင်းမရ">
            📶 PON မီးခုန် / မီးသုံးလုံးလင်းပြီး လိုင်းမရ
        </button>
        
        <button type="button" class="issue-btn" data-issue="Power တစ်ခုပဲလင်း">
            ⚡ Power တစ်ခုပဲလင်း
        </button>
        
        <button type="button" class="issue-btn" data-issue="No Power (မီးလုံးဝမလာပါ)">
            🔌 No Power (မီးလုံးဝမလာပါ)
        </button>
        
        <button type="button" class="issue-btn" data-issue="Password change (စကားဝှက်ပြောင်းရန်)" id="pwdBtn">
            🔑 Password change (စကားဝှက်ပြောင်းရန်)
        </button>

        <!-- Password Input Box -->
        <div id="passwordBox" class="hidden" style="margin-top: 10px;">
            <label for="newPassword">🔑 Password အသစ် ရိုက်ထည့်ပါ:</label>
            <input type="text" id="newPassword" placeholder="ပြောင်းလဲချင်သော Password အသစ်">
        </div>

        <button type="button" class="btn" id="submitBtn" style="margin-top: 15px;">ပြဿနာအား တင်ပြမည်</button>
    </div>
</div>

<script src="script.js"></script>
</body>
</html>
