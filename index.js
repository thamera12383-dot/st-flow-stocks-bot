require('dotenv').config();

const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });

const API_KEY = process.env.MASSIVE_API_KEY;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const WATCHLIST = ['SPY', 'QQQ', 'TSLA', 'NVDA', 'AAPL', 'AMD'];

const EXPIRATION_MODE = 'ALL';
const AUTO_SCAN_MS = 5 * 60 * 1000;
const USER_COOLDOWN_MS = 15 * 1000;
const CACHE_MS = 60 * 1000;
const ALERT_COOLDOWN_MS = 10 * 60 * 1000;

const NEAR_SPOT_RANGE = 0.15;
const MIN_WALL_STRENGTH_RATIO = 0.20;

const userCooldown = new Map();
const gexCache = new Map();
const lastAlert = new Map();

function isAdmin(userId) {
  return String(userId) === String(ADMIN_CHAT_ID);
}

function generateCode() {
  return `ST-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
}

function fmt(n) {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return 'N/A';
  return Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 });
}

function isValidSymbol(text) {
  return /^[A-Z]{1,6}$/.test(text);
}

async function hasActiveSubscription(userId) {
  if (isAdmin(userId)) return true;

  const { data, error } = await supabase
    .from('subscribers')
    .select('expires_at')
    .eq('user_id', String(userId))
    .single();

  if (error || !data) return false;

  return Number(data.expires_at) > Date.now();
}

async function remainingDays(userId) {
  const { data } = await supabase
    .from('subscribers')
    .select('expires_at')
    .eq('user_id', String(userId))
    .single();

  if (!data) return 0;

  const ms = Number(data.expires_at) - Date.now();
  return Math.max(0, Math.ceil(ms / (1000 * 60 * 60 * 24)));
}

// إنشاء كود
bot.onText(/^\/create\s+(\d+)$/i, async (msg, match) => {
  if (!isAdmin(msg.from.id)) return;

  const days = parseInt(match[1], 10);
  const code = generateCode();

  const { error } = await supabase.from('invite_codes').insert({
    code,
    days,
    used: false
  });

  if (error) {
    return bot.sendMessage(msg.chat.id, '❌ فشل إنشاء الكود.');
  }

  await bot.sendMessage(
    msg.chat.id,
    `✅ تم إنشاء كود جديد\n\n🔑 الكود:\n${code}\n\n⏳ المدة: ${days} يوم`
  );
});

// عرض الأكواد
bot.onText(/^\/codes$/i, async (msg) => {
  if (!isAdmin(msg.from.id)) return;

  const { data, error } = await supabase
    .from('invite_codes')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(30);

  if (error || !data.length) {
    return bot.sendMessage(msg.chat.id, '❌ لا توجد أكواد.');
  }

  let text = '📋 آخر الأكواد:\n\n';

  for (const c of data) {
    text += `🔑 ${c.code}\n⏳ ${c.days} يوم\n📌 مستخدم: ${c.used ? 'نعم' : 'لا'}\n\n`;
  }

  await bot.sendMessage(msg.chat.id, text);
});

// عرض المشتركين
bot.onText(/^\/users$/i, async (msg) => {
  if (!isAdmin(msg.from.id)) return;

  const { data, error } = await supabase
    .from('subscribers')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(50);

  if (error || !data.length) {
    return bot.sendMessage(msg.chat.id, '❌ لا يوجد مشتركين.');
  }

  let text = '👥 المشتركين:\n\n';

  for (const u of data) {
    const days = await remainingDays(u.user_id);
    text += `🆔 ${u.user_id}\n⏳ المتبقي: ${days} يوم\n\n`;
  }

  await bot.sendMessage(msg.chat.id, text);
});

// حذف مشترك
bot.onText(/^\/remove\s+(\d+)$/i, async (msg, match) => {
  if (!isAdmin(msg.from.id)) return;

  const targetId = match[1];

  await supabase
    .from('subscribers')
    .delete()
    .eq('user_id', String(targetId));

  await bot.sendMessage(msg.chat.id, `✅ تم حذف المستخدم ${targetId}`);
});

async function activateCode(code, userId, chatId) {
  const { data, error } = await supabase
    .from('invite_codes')
    .select('*')
    .eq('code', code)
    .single();

  if (error || !data) return false;

  if (data.used) {
    await bot.sendMessage(chatId, '❌ الكود مستخدم مسبقًا.');
    return true;
  }

  const expiresAt = Date.now() + data.days * 24 * 60 * 60 * 1000;

  await supabase.from('subscribers').upsert({
    user_id: String(userId),
    expires_at: expiresAt
  });

  await supabase
    .from('invite_codes')
    .update({
      used: true,
      used_by: String(userId),
      used_at: new Date().toISOString()
    })
    .eq('code', code);

  await bot.sendMessage(
    chatId,
    `✅ تم تفعيل اشتراكك\n\n⏳ المدة: ${data.days} يوم\n📅 المتبقي: ${data.days} يوم`
  );

  return true;
}

async function getOptionSnapshot(symbol) {
  let url = `https://api.massive.com/v3/snapshot/options/${symbol}`;
  let results = [];

  while (url) {
    const res = await axios.get(url, {
      params: url.includes('?') ? {} : { apiKey: API_KEY, limit: 250 },
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
    ...new Set(results.map(x => x.details?.expiration_date).filter(Boolean))
  ].sort();

  return {
    nearestExpiration: expirations[0] || 'N/A',
    farthestExpiration: expirations[expirations.length - 1] || 'N/A',
    expirationCount: expirations.length
  };
}

function isNearSpot(strike, spot) {
  if (!spot) return true;
  return Math.abs(strike - spot) / spot <= NEAR_SPOT_RANGE;
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

  if (!rows.length) throw new Error('NO_GEX_DATA');

  const nearbyRows = rows.filter(r => isNearSpot(r.strike, spot));

  const callCandidates = nearbyRows.filter(r => r.netGex > 0);
  const putCandidates = nearbyRows.filter(r => r.netGex < 0);

  const allCallCandidates = rows.filter(r => r.netGex > 0);
  const allPutCandidates = rows.filter(r => r.netGex < 0);

  const callWallSource = callCandidates.length ? callCandidates : allCallCandidates;
  const putWallSource = putCandidates.length ? putCandidates : allPutCandidates;

  const callWall = callWallSource.length
    ? callWallSource.reduce((a, b) => (b.netGex > a.netGex ? b : a))
    : rows.reduce((a, b) => (b.netGex > a.netGex ? b : a));

  const putWall = putWallSource.length
    ? putWallSource.reduce((a, b) => (b.netGex < a.netGex ? b : a))
    : rows.reduce((a, b) => (b.netGex < a.netGex ? b : a));

  const flipSource = nearbyRows.length ? nearbyRows : rows;

  const flip = flipSource.reduce((a, b) =>
    Math.abs(b.netGex) < Math.abs(a.netGex) ? b : a
  );

  const topLevels = (nearbyRows.length ? nearbyRows : rows)
    .sort((a, b) => Math.abs(b.netGex) - Math.abs(a.netGex))
    .slice(0, 5);

  const strongestWall = Math.max(
    Math.abs(callWall.netGex),
    Math.abs(putWall.netGex)
  );

  return {
    spot,
    nearestExpiration: expInfo.nearestExpiration,
    farthestExpiration: expInfo.farthestExpiration,
    expirationCount: expInfo.expirationCount,
    callWall,
    putWall,
    flip,
    topLevels,
    callStrengthRatio: strongestWall ? Math.abs(callWall.netGex) / strongestWall : 0,
    putStrengthRatio: strongestWall ? Math.abs(putWall.netGex) / strongestWall : 0
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
      ? '🟥 أقرب دعم جاما ضعيف:'
      : '🟥 أقرب دعم جاما قوي:';

  const resistanceTitle =
    a.callStrengthRatio < MIN_WALL_STRENGTH_RATIO
      ? '🟩 أقرب مقاومة جاما ضعيفة:'
      : '🟩 أقرب مقاومة جاما قوية:';

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

📊 أقوى مستويات الجاما القريبة:
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
    const userId = msg.from.id;
    const text = msg.text.trim().toUpperCase();

    if (text.startsWith('ST-')) {
      const activated = await activateCode(text, userId, chatId);
      if (activated) return;
    }

    if (!isValidSymbol(text)) return;

    const active = await hasActiveSubscription(userId);

    if (!active) {
      return bot.sendMessage(
        chatId,
        '❌ لا تملك اشتراك فعال.\n\nراسل الإدارة للحصول على كود تفعيل.'
      );
    }

    const last = userCooldown.get(chatId);

    if (last && Date.now() - last < USER_COOLDOWN_MS) {
      return bot.sendMessage(chatId, '⏳ انتظر 15 ثانية قبل طلب سهم جديد.');
    }

    userCooldown.set(chatId, Date.now());

    await bot.sendMessage(chatId, `⏳ جاري تحليل GEX لـ ${text}...`);

    const analysis = await analyzeGex(text);

    await bot.sendMessage(chatId, buildMessage(text, analysis));
  } catch (err) {
    console.error('MANUAL ERROR:', err.response?.data || err.message);
    await bot.sendMessage(msg.chat.id, '❌ لم أستطع جلب بيانات GEX لهذا الرمز.');
  }
});

async function autoScan() {
  if (!ADMIN_CHAT_ID) return;

  for (const symbol of WATCHLIST) {
    try {
      const a = await analyzeGex(symbol);

      if (!a.spot) continue;

      const callWallStrong = a.callStrengthRatio >= MIN_WALL_STRENGTH_RATIO;
      const putWallStrong = a.putStrengthRatio >= MIN_WALL_STRENGTH_RATIO;

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
      ].filter(Boolean).join('\n');

      const key = `${symbol}-${reason}`;
      const last = lastAlert.get(key);

      if (last && Date.now() - last < ALERT_COOLDOWN_MS) continue;

      lastAlert.set(key, Date.now());

      await bot.sendMessage(
        ADMIN_CHAT_ID,
        `🚨 تنبيه تلقائي GEX\n\n${reason}\n\n${buildMessage(symbol, a)}`
      );
    } catch (err) {
      console.error(`AUTO ERROR ${symbol}:`, err.response?.data || err.message);
    }
  }
}

bot.sendMessage(ADMIN_CHAT_ID, '✅ ST GEX Bot اشتغل: اشتراكات + يدوي + تلقائي');

setInterval(autoScan, AUTO_SCAN_MS);
autoScan();
