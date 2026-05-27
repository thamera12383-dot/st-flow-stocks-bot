require('dotenv').config();

const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });

const API_KEY = process.env.MASSIVE_API_KEY;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;

const WATCHLIST = ['SPY', 'QQQ', 'TSLA', 'NVDA', 'AAPL', 'AMD'];

const EXPIRATION_MODE = 'ALL';

const AUTO_SCAN_MS = 5 * 60 * 1000;
const USER_COOLDOWN_MS = 15 * 1000;
const CACHE_MS = 60 * 1000;
const ALERT_COOLDOWN_MS = 10 * 60 * 1000;

// أقل قوة للجدار حتى يعتبر مهم في التنبيهات
const MIN_WALL_STRENGTH_RATIO = 0.20;

const userCooldown = new Map();
const gexCache = new Map();
const lastAlert = new Map();

function fmt(n) {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return 'N/A';
  return Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 });
}

function isValidSymbol(text) {
  return /^[A-Z]{1,6}$/.test(text);
}

async function getOptionSnapshot(symbol) {
  let url = `https://api.massive.com/v3/snapshot/options/${symbol}`;
  let results = [];

  while (url) {
    const res = await axios.get(url, {
      params: url.includes('?')
        ? {}
        : {
            apiKey: API_KEY,
            limit: 250
          },
      timeout: 20000
    });

    results = results.concat(res.data.results || []);

    if (res.data.next_url) {
      url = `${res.data.next_url}&apiKey=${API_KEY}`;
    } else {
      url = null;
    }

    if (results.length >= 1500) break;
  }

  return { results };
}

function getExpirationInfo(results) {
  const expirations = [
    ...new Set(
      results
        .map(x => x.details?.expiration_date)
        .filter(Boolean)
    )
  ].sort();

  return {
    nearestExpiration: expirations[0] || 'N/A',
    farthestExpiration: expirations[expirations.length - 1] || 'N/A',
    expirationCount: expirations.length
  };
}

function calculateGex(data) {
  const results = data.results || [];
  const expInfo = getExpirationInfo(results);

  const byStrike = {};
  let spot = null;

  for (const item of results) {
    const details = item.details || {};
    const greeks = item.greeks || {};

    const strike = Number(details.strike_price);
    const type = String(details.contract_type || '').toLowerCase();
    const gamma = Number(greeks.gamma || 0);
    const oi = Number(item.open_interest || 0);

    if (!spot && item.underlying_asset?.price) {
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

  const callWall = rows.reduce((a, b) =>
    b.netGex > a.netGex ? b : a
  );

  const putWall = rows.reduce((a, b) =>
    b.netGex < a.netGex ? b : a
  );

  const nearSpotRows = rows.filter(r => {
    if (!spot) return true;
    const distance = Math.abs(r.strike - spot) / spot;
    return distance <= 0.15;
  });

  const flipSource = nearSpotRows.length ? nearSpotRows : rows;

  const flip = flipSource.reduce((a, b) =>
    Math.abs(b.netGex) < Math.abs(a.netGex) ? b : a
  );

  const topLevels = [...rows]
    .sort((a, b) => Math.abs(b.netGex) - Math.abs(a.netGex))
    .slice(0, 5);

  const strongestWall = Math.max(
    Math.abs(callWall.netGex),
    Math.abs(putWall.netGex)
  );

  const callStrengthRatio = Math.abs(callWall.netGex) / strongestWall;
  const putStrengthRatio = Math.abs(putWall.netGex) / strongestWall;

  return {
    spot,
    mode: EXPIRATION_MODE,
    nearestExpiration: expInfo.nearestExpiration,
    farthestExpiration: expInfo.farthestExpiration,
    expirationCount: expInfo.expirationCount,
    callWall,
    putWall,
    flip,
    topLevels,
    rows,
    callStrengthRatio,
    putStrengthRatio
  };
}

async function analyzeGex(symbol) {
  const cacheKey = `${symbol}-${EXPIRATION_MODE}`;
  const cached = gexCache.get(cacheKey);

  if (cached && Date.now() - cached.time < CACHE_MS) {
    return cached.data;
  }

  const data = await getOptionSnapshot(symbol);
  const analysis = calculateGex(data);

  gexCache.set(cacheKey, {
    time: Date.now(),
    data: analysis
  });

  return analysis;
}

function buildMiniChart(levels) {
  return levels
    .map(l => {
      const icon = l.netGex >= 0 ? '🟩' : '🟥';
      return `${icon} سترايك ${l.strike} | ${fmt(l.netGex)}`;
    })
    .join('\n');
}

function buildMessage(symbol, a) {
  const aboveFlip = a.spot > a.flip.strike;

  const directionText = aboveFlip
    ? `🚀 السعر فوق Gamma Flip ${a.flip.strike}`
    : `🔻 السعر تحت Gamma Flip ${a.flip.strike}`;

  const supportTitle =
    a.putStrengthRatio < MIN_WALL_STRENGTH_RATIO
      ? '🟥 دعم جاما ضعيف:'
      : '🟥 دعم جاما قوي:';

  const resistanceTitle =
    a.callStrengthRatio < MIN_WALL_STRENGTH_RATIO
      ? '🟩 مقاومة جاما ضعيفة:'
      : '🟩 مقاومة جاما قوية:';

  return `🧠 ST GEX Analysis

📊 السهم: ${symbol}
💵 السعر الحالي: ${fmt(a.spot)}

📅 أقرب انتهاء: ${a.nearestExpiration}
📅 أبعد انتهاء: ${a.farthestExpiration}
🔢 عدد الانتهاءات: ${a.expirationCount}

${resistanceTitle}
سترايك ${a.callWall.strike}
القوة: +${fmt(a.callWall.netGex)}

${supportTitle}
سترايك ${a.putWall.strike}
القوة: ${fmt(a.putWall.netGex)}

🎯 Gamma Flip:
سترايك ${a.flip.strike}
القيمة: ${fmt(a.flip.netGex)}

📍 حالة السعر:
${directionText}

📊 أقوى مستويات الجاما:
${buildMiniChart(a.topLevels)}

⚠️ القراءة:
🟩 قرب مقاومة الجاما = احتمال تهدئة / رفض
🟥 قرب دعم الجاما = احتمال ارتداد / دعم
🎯 اختراق Gamma Flip = زيادة سرعة الحركة

ليست توصية شراء أو بيع.`;
}

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
      '❌ لم أستطع جلب بيانات GEX لهذا الرمز.'
    );
  }
});

async function autoScan() {
  if (!ADMIN_CHAT_ID) return;

  for (const symbol of WATCHLIST) {
    try {
      const a = await analyzeGex(symbol);

      if (!a.spot) continue;

      const callWallStrong =
        a.callStrengthRatio >= MIN_WALL_STRENGTH_RATIO;

      const putWallStrong =
        a.putStrengthRatio >= MIN_WALL_STRENGTH_RATIO;

      const nearCall =
        callWallStrong &&
        Math.abs(a.spot - a.callWall.strike) / a.spot <= 0.005;

      const nearPut =
        putWallStrong &&
        Math.abs(a.spot - a.putWall.strike) / a.spot <= 0.005;

      const nearFlip =
        Math.abs(a.spot - a.flip.strike) / a.spot <= 0.005;

      if (!nearCall && !nearPut && !nearFlip) continue;

      const reason = [
        nearCall ? `🟩 قريب من مقاومة جاما قوية ${a.callWall.strike}` : null,
        nearPut ? `🟥 قريب من دعم جاما قوي ${a.putWall.strike}` : null,
        nearFlip ? `🎯 قريب من Gamma Flip ${a.flip.strike}` : null
      ]
        .filter(Boolean)
        .join('\n');

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
