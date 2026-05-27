require('dotenv').config();

const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });

const API_KEY = process.env.MASSIVE_API_KEY;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;

// الأسهم التلقائية
const WATCHLIST = ['SPY', 'QQQ', 'AAPL', 'AMD', 'TSLA', 'NVDA'];

const AUTO_SCAN_MS = 5 * 60 * 1000;
const USER_COOLDOWN_MS = 15 * 1000;
const CACHE_MS = 60 * 1000;
const ALERT_COOLDOWN_MS = 10 * 60 * 1000;

const userCooldown = new Map();
const gexCache = new Map();
const lastAlert = new Map();

function fmt(n) {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return 'N/A';
  return Number(n).toLocaleString('en-US', {
    maximumFractionDigits: 2
  });
}

function isValidSymbol(text) {
  return /^[A-Z]{1,6}$/.test(text);
}

async function getOptionSnapshot(symbol) {
  const url = `https://api.massive.com/v3/snapshot/options/${symbol}`;

  const res = await axios.get(url, {
    params: {
      apiKey: API_KEY,
      limit: 250
    },
    timeout: 15000
  });

  return res.data;
}

function calculateGex(data) {
  const results = data.results || [];
  const byStrike = {};
  let spot = null;

  for (const item of results) {
    const details = item.details || {};
    const greeks = item.greeks || {};

    const strike = Number(details.strike_price);
    const type = String(details.contract_type || '').toLowerCase();
    const gamma = Number(greeks.gamma || 0);
    const oi = Number(item.open_interest || 0);

    if (!spot && item.underlying_asset && item.underlying_asset.price) {
      spot = Number(item.underlying_asset.price);
    }

    if (!strike || !gamma || !oi) continue;

    if (!byStrike[strike]) {
      byStrike[strike] = {
        strike,
        callGex: 0,
        putGex: 0,
        netGex: 0
      };
    }

    // Net GEX Strike = (Call OI * Call Gamma * 100) - (Put OI * Put Gamma * 100)
    const gex = oi * gamma * 100;

    if (type === 'call') {
      byStrike[strike].callGex += gex;
      byStrike[strike].netGex += gex;
    }

    if (type === 'put') {
      byStrike[strike].putGex += gex;
      byStrike[strike].netGex -= gex;
    }
  }

  const rows = Object.values(byStrike).sort((a, b) => a.strike - b.strike);

  if (!rows.length) {
    throw new Error('NO_GEX_DATA');
  }

  const callWall = rows.reduce((a, b) => b.netGex > a.netGex ? b : a);
  const putWall = rows.reduce((a, b) => b.netGex < a.netGex ? b : a);
  const flip = rows.reduce((a, b) =>
    Math.abs(b.netGex) < Math.abs(a.netGex) ? b : a
  );

  return {
    spot,
    callWall,
    putWall,
    flip,
    rows
  };
}

async function analyzeGex(symbol) {
  const cached = gexCache.get(symbol);

  if (cached && Date.now() - cached.time < CACHE_MS) {
    return cached.data;
  }

  const data = await getOptionSnapshot(symbol);
  const analysis = calculateGex(data);

  gexCache.set(symbol, {
    time: Date.now(),
    data: analysis
  });

  return analysis;
}

function buildMessage(symbol, a) {
  return `🧠 ST GEX Analysis

📊 السهم: ${symbol}
💵 السعر الحالي: ${fmt(a.spot)}

🟩 Call Wall: ${a.callWall.strike}
القوة: +${fmt(a.callWall.netGex)}

🟥 Put Wall: ${a.putWall.strike}
القوة: ${fmt(a.putWall.netGex)}

🎯 Gamma Flip: ${a.flip.strike}
القيمة: ${fmt(a.flip.netGex)}

📌 الحسبة:
Net GEX = (Call OI × Call Gamma × 100) - (Put OI × Put Gamma × 100)

⚠️ القراءة:
فوق Gamma Flip = حركة أسرع غالبًا
قرب Call Wall = احتمال تهدئة/مقاومة
قرب Put Wall = احتمال دعم/ارتداد

ليست توصية شراء أو بيع.`;
}

// يدوي: اكتب الرمز مباشرة مثل AAPL
bot.on('message', async (msg) => {
  try {
    if (!msg.text) return;
    if (msg.text.startsWith('/')) return;

    const chatId = msg.chat.id;
    const symbol = msg.text.trim().toUpperCase();

    if (!isValidSymbol(symbol)) return;

    const last = userCooldown.get(chatId);
    if (last && Date.now() - last < USER_COOLDOWN_MS) {
      return bot.sendMessage(chatId, '⏳ انتظر 15 ثانية قبل طلب سهم جديد.');
    }

    userCooldown.set(chatId, Date.now());

    await bot.sendMessage(chatId, `⏳ جاري تحليل GEX لـ ${symbol}...`);

    const analysis = await analyzeGex(symbol);
    await bot.sendMessage(chatId, buildMessage(symbol, analysis));

  } catch (err) {
    console.error('MANUAL ERROR:', err.response?.data || err.message);
    await bot.sendMessage(
      msg.chat.id,
      '❌ لم أستطع جلب بيانات GEX لهذا الرمز. تأكد أن الرمز صحيح وأن اشتراك Massive يدعم بيانات Options/Greeks/OI.'
    );
  }
});

// تلقائي: يفحص الأسهم المحددة في WATCHLIST
async function autoScan() {
  if (!ADMIN_CHAT_ID) return;

  for (const symbol of WATCHLIST) {
    try {
      const a = await analyzeGex(symbol);

      if (!a.spot) continue;

      const nearCall =
        Math.abs(a.spot - a.callWall.strike) / a.spot <= 0.005;

      const nearPut =
        Math.abs(a.spot - a.putWall.strike) / a.spot <= 0.005;

      const nearFlip =
        Math.abs(a.spot - a.flip.strike) / a.spot <= 0.005;

      if (!nearCall && !nearPut && !nearFlip) continue;

      const reason = [
        nearCall ? '🟩 قريب من Call Wall' : null,
        nearPut ? '🟥 قريب من Put Wall' : null,
        nearFlip ? '🎯 قريب من Gamma Flip' : null
      ].filter(Boolean).join('\n');

      const key = `${symbol}-${reason}`;
      const last = lastAlert.get(key);

      if (last && Date.now() - last < ALERT_COOLDOWN_MS) continue;

      lastAlert.set(key, Date.now());

      await bot.sendMessage(
        ADMIN_CHAT_ID,
        `🚨 تنبيه تلقائي GEX

${reason}

${buildMessage(symbol, a)}`
      );

    } catch (err) {
      console.error(`AUTO ERROR ${symbol}:`, err.response?.data || err.message);
    }
  }
}

bot.sendMessage(
  ADMIN_CHAT_ID,
  '✅ ST GEX Bot اشتغل: يدوي + تلقائي'
);

setInterval(autoScan, AUTO_SCAN_MS);
autoScan();
