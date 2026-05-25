const TelegramBot = require('node-telegram-bot-api');
const { createClient } = require('@supabase/supabase-js');

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });

const API_KEY = process.env.MASSIVE_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const ADMIN_IDS = String(process.env.ADMIN_IDS || '')
  .split(',')
  .map(x => x.trim())
  .filter(Boolean);

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

const userCooldown = new Map();
const CACHE = new Map();
const activeUpdates = new Map();

const USER_COOLDOWN_SECONDS = 10;
const CACHE_SECONDS = 60;
const UPDATE_INTERVAL_MS = 60 * 1000;
const UPDATE_DURATION_MS = 5 * 60 * 1000;

const EXPIRY_WARNING_DAYS = 3;
const CHECK_EXPIRY_INTERVAL = 12 * 60 * 60 * 1000;

// =====================
// Subscription
// =====================

function nowIso() {
  return new Date().toISOString();
}

function addDaysIso(days) {
  const d = new Date();
  d.setDate(d.getDate() + Number(days));
  return d.toISOString();
}

function formatDate(v) {
  if (!v) return 'غير متوفر';

  return new Date(v).toLocaleString('ar-SA', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function isAdmin(chatId) {
  return ADMIN_IDS.includes(String(chatId));
}

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = 'ST-';

  for (let i = 0; i < 4; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }

  code += '-';

  for (let i = 0; i < 4; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }

  return code;
}

async function createActivationCode(days = 30) {
  const code = generateCode();
  const expiresAt = addDaysIso(days);

  const { error } = await supabase
    .from('activation_codes')
    .insert({
      code,
      used: false,
      expires_at: expiresAt
    });

  if (error) throw error;

  return { code, days, expiresAt };
}

async function getUserAccess(chatId) {
  const { data, error } = await supabase
    .from('users_access')
    .select('*')
    .eq('telegram_id', String(chatId))
    .single();

  if (error && error.code !== 'PGRST116') throw error;

  return data || null;
}

async function hasActiveAccess(chatId) {
  const user = await getUserAccess(chatId);

  if (!user) return false;
  if (!user.active) return false;
  if (!user.expires_at) return false;

  return new Date(user.expires_at).getTime() > Date.now();
}

async function requireAccess(chatId) {
  const access = await hasActiveAccess(chatId);

  if (access) return true;

  await bot.sendMessage(
    chatId,
`🔒 البوت مخصص للمشتركين فقط.

لتفعيل اشتراكك:

/redeem CODE

مثال:
/redeem ST-ABCD-1234`
  );

  return false;
}
async function redeemCode(chatId, code) {
  const cleanCode = String(code || '').trim().toUpperCase();

  const { data: activation, error } = await supabase
    .from('activation_codes')
    .select('*')
    .eq('code', cleanCode)
    .single();

  if (error || !activation) {
    return { ok: false, message: '❌ كود التفعيل غير صحيح.' };
  }

  if (activation.used) {
    return { ok: false, message: '⚠️ هذا الكود مستخدم مسبقًا.' };
  }

  const expiresAt = activation.expires_at;

  if (!expiresAt || new Date(expiresAt).getTime() < Date.now()) {
    return { ok: false, message: '⚠️ هذا الكود منتهي الصلاحية.' };
  }

  const { error: updateError } = await supabase
    .from('activation_codes')
    .update({
      used: true,
      telegram_id: String(chatId),
      activated_at: nowIso()
    })
    .eq('code', cleanCode)
    .eq('used', false);

  if (updateError) throw updateError;

  const { error: userError } = await supabase
    .from('users_access')
    .upsert(
      {
        telegram_id: String(chatId),
        code_used: cleanCode,
        expires_at: expiresAt,
        active: true,
        notified_3_days: false
      },
      { onConflict: 'telegram_id' }
    );

  if (userError) throw userError;

  return {
    ok: true,
    message:
`✅ تم تفعيل اشتراكك بنجاح.

ينتهي في:
${formatDate(expiresAt)}

يمكنك الآن استخدام البوت.`
  };
}

// =====================
// Helpers
// =====================

function fmt(n) {
  if (n === undefined || n === null || isNaN(Number(n))) return 'غير متوفر';
  return Number(n).toLocaleString('en-US');
}

function fmtPrice(n) {
  if (n === undefined || n === null || isNaN(Number(n))) return 'غير متوفر';
  return Number(n).toFixed(2);
}

function fmtPercent(n) {
  if (n === undefined || n === null || isNaN(Number(n))) return 'غير متوفر';
  return `${Number(n).toFixed(2)}%`;
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function canRequest(chatId) {
  const last = userCooldown.get(chatId) || 0;
  const diff = nowSeconds() - last;

  if (diff < USER_COOLDOWN_SECONDS) {
    return {
      ok: false,
      wait: USER_COOLDOWN_SECONDS - diff
    };
  }

  userCooldown.set(chatId, nowSeconds());
  return { ok: true };
}

function getContractType(item) {
  return String(item?.details?.contract_type || '').toUpperCase();
}

function getStrike(item) {
  return item?.details?.strike_price || 'غير متوفر';
}

function getVolume(item) {
  return Number(item?.day?.volume || 0);
}

function getOI(item) {
  return Number(item?.open_interest || 0);
}

function getExpiration(item) {
  return item?.details?.expiration_date || 'غير متوفر';
}

function getIV(item) {
  return item?.implied_volatility;
}

function getDelta(item) {
  return item?.greeks?.delta;
}

function getGamma(item) {
  return item?.greeks?.gamma;
}

function getTheta(item) {
  return item?.greeks?.theta;
}

function getBid(item) {
  return Number(item?.last_quote?.bid || 0);
}

function getAsk(item) {
  return Number(item?.last_quote?.ask || 0);
}

function getMidPrice(item) {
  const bid = getBid(item);
  const ask = getAsk(item);

  if (bid > 0 && ask > 0) {
    return (bid + ask) / 2;
  }

  return Number(item?.day?.close || item?.last_trade?.price || 0);
}

function gammaText(gamma) {
  const g = Number(gamma);

  if (gamma === undefined || gamma === null || isNaN(g)) return 'غير متوفر';
  if (g >= 0.08) return 'مرتفع جدًا';
  if (g >= 0.04) return 'مرتفع';
  if (g >= 0.02) return 'متوسط';

  return 'منخفض';
}

function distancePercent(strike, stockPrice) {
  const s = Number(strike);
  const p = Number(stockPrice);

  if (!s || !p || isNaN(s) || isNaN(p)) return null;

  return Math.abs(((s - p) / p) * 100);
}

function daysToExpiration(dateStr) {
  if (!dateStr) return 999;

  const now = new Date();
  const exp = new Date(dateStr);

  return Math.ceil((exp - now) / (1000 * 60 * 60 * 24));
}
// =====================
// Massive API
// =====================

async function apiGet(url) {
  if (!API_KEY) {
    throw new Error('Missing MASSIVE_API_KEY');
  }

  const res = await fetch(url);
  const data = await res.json();

  if (!res.ok) {
    throw new Error(data?.error || data?.message || 'API Error');
  }

  return data;
}

async function getStockSnapshot(symbol) {
  const url =
    `https://api.massive.com/v2/aggs/ticker/${symbol}/prev?adjusted=true&apiKey=${API_KEY}`;

  const data = await apiGet(url);
  const r = data?.results?.[0];

  if (!r) return null;

  const change = r.o
    ? ((r.c - r.o) / r.o) * 100
    : null;

  return {
    price: r.c,
    open: r.o,
    high: r.h,
    low: r.l,
    volume: r.v,
    change
  };
}

async function getOptionsChain(symbol) {
  const url =
    `https://api.massive.com/v3/snapshot/options/${symbol}?limit=250&apiKey=${API_KEY}`;

  const data = await apiGet(url);

  return data.results || [];
}

// =====================
// Smart Scoring
// =====================

function qualityScore(item, stockPrice) {
  const volume = getVolume(item);
  const oi = getOI(item);
  const gamma = Number(getGamma(item) || 0);
  const delta = Math.abs(Number(getDelta(item) || 0));
  const iv = Number(getIV(item) || 0);
  const distance = distancePercent(getStrike(item), stockPrice);
  const dte = daysToExpiration(getExpiration(item));
  const bid = getBid(item);
  const ask = getAsk(item);
  const mid = getMidPrice(item);

  let score = 0;

  // قوة السيولة
  score += volume * 1.2;
  score += oi * 0.35;

  // دخول جديد
  if (volume > oi) score += 6000;
  else if (volume > oi * 0.7) score += 3000;

  // قرب السترايك من السعر
  if (distance !== null) {
    if (distance <= 0.5) score += 6000;
    else if (distance <= 1) score += 4500;
    else if (distance <= 2) score += 2500;
    else if (distance <= 3) score += 1000;
  }

  // Gamma
  if (gamma >= 0.08) score += 5000;
  else if (gamma >= 0.04) score += 3000;
  else if (gamma >= 0.02) score += 1200;

  // Delta مناسبة للمضاربة
  if (delta >= 0.25 && delta <= 0.45) score += 3000;
  else if (delta > 0.45 && delta <= 0.65) score += 1200;

  // انتهاء قريب
  if (dte >= 0 && dte <= 7) score += 2000;
  else if (dte <= 14) score += 800;

  // سعر عقد مناسب تقريبًا 150-250$
  if (mid >= 1.5 && mid <= 2.5) score += 3000;

  // سبريد مقبول
  if (bid > 0 && ask > 0) {
    const spreadPercent = ((ask - bid) / mid) * 100;

    if (spreadPercent <= 8) score += 1500;
    else if (spreadPercent <= 15) score += 700;
    else score -= 1000;
  }

  // IV مرتفع جدًا يقلل الجودة
  if (iv >= 0.9) score -= 2500;
  else if (iv >= 0.6) score -= 1000;

  return Math.round(score);
}

function topContracts(chain, type, stockPrice, count = 3) {
  return chain
    .filter(x => {
      if (getContractType(x) !== type) return false;

      const strike = Number(getStrike(x));
      const dist = distancePercent(strike, stockPrice);

      if (isNaN(strike) || dist === null) return false;

      return dist <= 3;
    })
    .map(item => ({
      item,
      qScore: qualityScore(item, stockPrice)
    }))
    .sort((a, b) => b.qScore - a.qScore)
    .slice(0, count)
    .map(x => x.item);
}

function topGammaContracts(chain, stockPrice, count = 3) {
  return chain
    .filter(x => {
      const gamma = Number(getGamma(x) || 0);
      const strike = Number(getStrike(x));
      const dist = distancePercent(strike, stockPrice);
      const volume = getVolume(x);

      return gamma > 0 && volume > 0 && dist !== null && dist <= 3;
    })
    .sort((a, b) => Number(getGamma(b) || 0) - Number(getGamma(a) || 0))
    .slice(0, count);
}

function nearestSupportResistance(stock) {
  if (!stock) {
    return {
      support: 'غير متوفر',
      resistance: 'غير متوفر'
    };
  }

  return {
    support: stock.low,
    resistance: stock.high
  };
}

function momentumText(stock) {
  if (!stock || stock.change === null || stock.change === undefined) {
    return 'غير متوفر';
  }

  if (stock.change > 1) return '🔥 صاعد قوي';
  if (stock.change > 0) return '🟢 صاعد';
  if (stock.change < -1) return '🔴 هابط قوي';
  if (stock.change < 0) return '🔴 هابط';

  return '⚪ محايد';
}

function getStrongestContract(calls, puts, stockPrice) {
  const all = [
    ...calls.map(x => ({
      item: x,
      side: 'CALL',
      qScore: qualityScore(x, stockPrice)
    })),
    ...puts.map(x => ({
      item: x,
      side: 'PUT',
      qScore: qualityScore(x, stockPrice)
    }))
  ];

  if (!all.length) return null;

  all.sort((a, b) => b.qScore - a.qScore);

  return all[0];
}

function biasText(calls, puts, stockPrice) {
  const calcSide = list =>
    list.reduce((sum, item) => {
      return sum + qualityScore(item, stockPrice);
    }, 0);

  const totalCall = calcSide(calls);
  const totalPut = calcSide(puts);

  if (totalCall > totalPut * 1.25) return '🟢 تدفق شرائي قوي';
  if (totalPut > totalCall * 1.25) return '🔴 تدفق بيعي قوي';

  return '⚪ تدفق متوازن';
}
// =====================
// Message Builder
// =====================

async function buildFlowMessage(symbol) {
  const cached = CACHE.get(symbol);

  if (cached && nowSeconds() - cached.time < CACHE_SECONDS) {
    return cached.message;
  }

  const stock = await getStockSnapshot(symbol);

  if (!stock) {
    return `⚠️ تعذر جلب بيانات ${symbol}`;
  }

  const chain = await getOptionsChain(symbol);

  const calls = topContracts(chain, 'CALL', stock.price, 3);
  const puts = topContracts(chain, 'PUT', stock.price, 3);

  const gammaLeaders = topGammaContracts(chain, stock.price, 3);

  const sr = nearestSupportResistance(stock);
  const momentum = momentumText(stock);
  const bias = biasText(calls, puts, stock.price);
  const strongest = getStrongestContract(calls, puts, stock.price);

  if (!strongest) {
    const msg =
`⚠️ لا توجد عقود قريبة كافية على ${symbol}

💰 السعر الحالي: ${fmtPrice(stock.price)}

يرجى المحاولة لاحقاً.`;

    CACHE.set(symbol, {
      time: nowSeconds(),
      message: msg
    });

    return msg;
  }

  const item = strongest.item;
  const side = strongest.side;
  const strike = getStrike(item);
  const expiry = getExpiration(item);
  const volume = getVolume(item);
  const oi = getOI(item);
  const delta = getDelta(item);
  const gamma = getGamma(item);
  const iv = getIV(item);
  const theta = getTheta(item);
  const bid = getBid(item);
  const ask = getAsk(item);
  const mid = getMidPrice(item);
  const qScore = strongest.qScore;
  const dist = distancePercent(strike, stock.price);

  let qualityLabel = 'متوسطة';

  if (qScore >= 90000) {
    qualityLabel = 'استثنائية';
  } else if (qScore >= 60000) {
    qualityLabel = 'قوية جدًا';
  } else if (qScore >= 35000) {
    qualityLabel = 'قوية';
  } else if (qScore >= 20000) {
    qualityLabel = 'جيدة';
  }

  const gammaSection =
    gammaLeaders.length
      ? gammaLeaders
          .map((x, i) => {
            const g = Number(getGamma(x) || 0);
            return `${i + 1}) ${getContractType(x)} ${getStrike(x)} — Γ ${g.toFixed(2)}`;
          })
          .join('\n')
      : 'لا توجد بيانات Gamma قريبة';

  let smartRead = '';

  if (volume > oi && Number(gamma || 0) >= 0.04) {
    smartRead =
      'دخول سيولة جديدة مع Gamma مرتفعة. احتمال حركة سريعة إذا استمر الزخم.';
  } else if (volume > oi) {
    smartRead =
      'دخول سيولة جديدة على العقد الأقوى. راقب ثبات السعر قرب المستوى الحالي.';
  } else {
    smartRead =
      'التمركز موجود، لكنه لا يؤكد دخول هجومي قوي حتى الآن.';
  }

  const message =
`🚨 ${symbol} — ${bias}

📈 الاتجاه: ${momentum}
💰 السعر: ${fmtPrice(stock.price)}
📊 التغير: ${
  stock.change !== null && stock.change !== undefined
    ? fmtPercent(stock.change)
    : 'غير متوفر'
}

🎯 العقد الأقوى: ${side} ${strike}
📅 الانتهاء: ${expiry}

💵 سعر العقد:
Bid ${bid ? bid.toFixed(2) : 'N/A'} | Ask ${ask ? ask.toFixed(2) : 'N/A'} | Mid ${mid ? mid.toFixed(2) : 'N/A'}

⭐ الجودة: ${qualityLabel}
📍 قرب العقد: ${dist !== null ? dist.toFixed(2) + '%' : 'غير متوفر'}
📦 الحجم: ${fmt(volume)}
📂 OI: ${fmt(oi)}

Δ Delta: ${
  delta !== undefined && delta !== null
    ? Number(delta).toFixed(2)
    : 'غير متوفر'
}
Γ Gamma: ${gammaText(gamma)}
IV: ${
  iv !== undefined && iv !== null
    ? fmtPercent(Number(iv) * 100)
    : 'غير متوفر'
}
Θ Theta: ${
  theta !== undefined && theta !== null
    ? Number(theta).toFixed(2)
    : 'غير متوفر'
}

⚡ أعلى Gamma:
${gammaSection}

🧠 القراءة:
${smartRead}

⚠️ مراقبة:
الدعم: ${fmtPrice(sr.support)}
المقاومة: ${fmtPrice(sr.resistance)}

⏱ التحديث: كل 60 ثانية لمدة 5 دقائق`;

  CACHE.set(symbol, {
    time: nowSeconds(),
    message
  });

  return message;
}

// =====================
// Subscription Expiry Check
// =====================

async function checkExpiringSubscriptions() {
  try {
    const now = new Date();

    const warningDate = new Date(
      now.getTime() +
        EXPIRY_WARNING_DAYS *
          24 *
          60 *
          60 *
          1000
    );

    const { data: users, error } = await supabase
      .from('users_access')
      .select('*')
      .eq('active', true);

    if (error) throw error;

    for (const user of users || []) {
      if (!user.expires_at) continue;

      const expiry = new Date(user.expires_at);
      const alreadyNotified = user.notified_3_days === true;
      const isWithinWarning = expiry <= warningDate && expiry > now;

      if (isWithinWarning && !alreadyNotified) {
        await bot.sendMessage(
          user.telegram_id,
`⚠️ تنبيه اشتراك

اشتراكك سينتهي خلال 3 أيام.

📅 تاريخ الانتهاء:
${formatDate(user.expires_at)}

للتجديد تواصل مع الإدارة.`
        );

        await supabase
          .from('users_access')
          .update({
            notified_3_days: true
          })
          .eq('telegram_id', user.telegram_id);
      }
    }
  } catch (err) {
    console.error('Expiry Check Error:', err.message);
  }
}

// =====================
// Auto Updates
// =====================

function clearUpdate(chatId) {
  const active = activeUpdates.get(chatId);

  if (active?.intervalId) {
    clearInterval(active.intervalId);
  }

  if (active?.timeoutId) {
    clearTimeout(active.timeoutId);
  }

  activeUpdates.delete(chatId);
}

function startAutoUpdate(chatId, symbol) {
  clearUpdate(chatId);

  const intervalId = setInterval(async () => {
    try {
      const msg = await buildFlowMessage(symbol);

      await bot.sendMessage(
        chatId,
        msg
      );
    } catch (err) {
      console.error(err);

      await bot.sendMessage(
        chatId,
        `⚠️ تعذر تحديث بيانات ${symbol}\n${err.message}`
      );

      clearUpdate(chatId);
    }
  }, UPDATE_INTERVAL_MS);

  const timeoutId = setTimeout(async () => {
    clearUpdate(chatId);

    await bot.sendMessage(
      chatId,
      `✅ انتهت متابعة ${symbol} لمدة 5 دقائق.`
    );
  }, UPDATE_DURATION_MS);

  activeUpdates.set(chatId, {
    symbol,
    intervalId,
    timeoutId
  });
}

// =====================
// Flow Request
// =====================

async function sendFlow(chatId, symbol) {
  try {
    const access = await requireAccess(chatId);

    if (!access) return;

    const check = canRequest(chatId);

    if (!check.ok) {
      await bot.sendMessage(
        chatId,
        `⏳ انتظر ${check.wait} ثواني قبل طلب جديد.`
      );

      return;
    }

    await bot.sendMessage(
      chatId,
      `⏳ جاري جلب بيانات ${symbol}...`
    );

    const msg = await buildFlowMessage(symbol);

    await bot.sendMessage(
      chatId,
      msg
    );

    startAutoUpdate(chatId, symbol);
  } catch (err) {
    console.error(err);

    const message = String(err.message || '');

    const entitlement =
      message.toLowerCase().includes('not entitled') ||
      message.toLowerCase().includes('entitled');

    if (entitlement) {
      await bot.sendMessage(
        chatId,
`⚠️ لا توجد بيانات متاحة حالياً.

لم يتم تفعيل اشتراك البيانات المباشرة للمالك بعد.`
      );

      return;
    }

    if (message.includes('Missing MASSIVE_API_KEY')) {
      await bot.sendMessage(
        chatId,
`⚠️ مفتاح MASSIVE_API_KEY غير موجود.

أضفه داخل Railway Variables.`
      );

      return;
    }

    await bot.sendMessage(
      chatId,
      `حدث خطأ:\n${message}`
    );
  }
}

// =====================
// Bot Commands
// =====================

bot.onText(/\/start/, async (msg) => {
  await bot.sendMessage(
    msg.chat.id,
`🚀 مرحبًا بك في ST Flow Stocks

🔒 البوت للمشتركين فقط.

لتفعيل اشتراكك:

/redeem CODE

مثال:
/redeem ST-ABCD-1234`
  );
});

bot.onText(/\/myid/, async (msg) => {
  await bot.sendMessage(
    msg.chat.id,
    `🆔 Telegram ID:\n${msg.chat.id}`
  );
});

bot.onText(/\/redeem (.+)/, async (msg, match) => {
  try {
    const result = await redeemCode(
      msg.chat.id,
      match[1]
    );

    await bot.sendMessage(
      msg.chat.id,
      result.message
    );
  } catch (err) {
    await bot.sendMessage(
      msg.chat.id,
      `حدث خطأ أثناء التفعيل:\n${err.message}`
    );
  }
});

bot.onText(/\/status/, async (msg) => {
  const sub = await getUserAccess(msg.chat.id);

  if (!sub) {
    await bot.sendMessage(
      msg.chat.id,
`🔒 لا يوجد اشتراك فعال.

للتفعيل:
/redeem CODE`
    );

    return;
  }

  const active = await hasActiveAccess(msg.chat.id);

  await bot.sendMessage(
    msg.chat.id,
`${active ? '✅ اشتراكك فعال' : '❌ اشتراكك منتهي'}

الكود المستخدم:
${sub.code_used || 'غير متوفر'}

ينتهي في:
${formatDate(sub.expires_at)}`
  );
});

bot.onText(/\/gencode(?:\s+(\d+))?/, async (msg, match) => {
  if (!isAdmin(msg.chat.id)) {
    await bot.sendMessage(
      msg.chat.id,
      '⛔ هذا الأمر للأدمن فقط.'
    );

    return;
  }

  const days = Number(match[1] || 30);
  const result = await createActivationCode(days);

  await bot.sendMessage(
    msg.chat.id,
`✅ تم إنشاء كود جديد

الكود:
${result.code}

المدة:
${days} يوم

ينتهي في:
${formatDate(result.expiresAt)}

طريقة التفعيل:

/redeem ${result.code}`
  );
});

bot.onText(/\/help/, async (msg) => {
  await bot.sendMessage(
    msg.chat.id,
`❓ الأوامر المتاحة

/status
معرفة حالة الاشتراك

/stop
إيقاف التحديث

/redeem CODE
تفعيل الاشتراك`
  );
});

bot.onText(/\/stop/, async (msg) => {
  clearUpdate(msg.chat.id);

  await bot.sendMessage(
    msg.chat.id,
    '🛑 تم إيقاف التحديثات.'
  );
});

bot.on('message', async (msg) => {
  const text = msg.text;

  if (!text) return;
  if (text.startsWith('/')) return;

  const symbol = text.trim().toUpperCase();

  if (!/^[A-Z]{1,5}$/.test(symbol)) {
    await bot.sendMessage(
      msg.chat.id,
      '⚠️ الرمز غير صحيح.'
    );

    return;
  }

  sendFlow(
    msg.chat.id,
    symbol
  );
});

checkExpiringSubscriptions();

setInterval(() => {
  checkExpiringSubscriptions();
}, CHECK_EXPIRY_INTERVAL);

console.log('ST Flow Stocks bot running...');
