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
// Subscription System
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

  return {
    code,
    days,
    expiresAt
  };
}

async function getUserAccess(chatId) {
  const { data, error } = await supabase
    .from('users_access')
    .select('*')
    .eq('telegram_id', String(chatId))
    .single();

  if (error && error.code !== 'PGRST116') {
    throw error;
  }

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
  const cleanCode = String(code || '')
    .trim()
    .toUpperCase();

  const { data: activation, error } = await supabase
    .from('activation_codes')
    .select('*')
    .eq('code', cleanCode)
    .single();

  if (error || !activation) {
    return {
      ok: false,
      message: '❌ كود التفعيل غير صحيح.'
    };
  }

  if (activation.used) {
    return {
      ok: false,
      message: '⚠️ هذا الكود مستخدم مسبقًا.'
    };
  }

  const expiresAt = activation.expires_at;

  if (!expiresAt || new Date(expiresAt).getTime() < Date.now()) {
    return {
      ok: false,
      message: '⚠️ هذا الكود منتهي الصلاحية.'
    };
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
      {
        onConflict: 'telegram_id'
      }
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
  if (n === undefined || n === null || isNaN(Number(n))) {
    return 'غير متوفر';
  }

  return Number(n).toLocaleString('en-US');
}

function fmtPrice(n) {
  if (n === undefined || n === null || isNaN(Number(n))) {
    return 'غير متوفر';
  }

  return Number(n).toFixed(2);
}

function fmtPercent(n) {
  if (n === undefined || n === null || isNaN(Number(n))) {
    return 'غير متوفر';
  }

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
  return String(item?.details?.contract_type || '').toLowerCase();
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

function gammaText(gamma) {
  const g = Number(gamma);

  if (gamma === undefined || gamma === null || isNaN(g)) {
    return 'غير متوفر';
  }

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

  const today = new Date();
  const exp = new Date(dateStr);

  const diff =
    exp.getTime() - today.getTime();

  return Math.ceil(
    diff / (1000 * 60 * 60 * 24)
  );
}

function qualityScore(item, stockPrice) {
  let score = 0;

  const volume = getVolume(item);
  const oi = getOI(item);
  const gamma = Number(getGamma(item) || 0);
  const delta = Math.abs(Number(getDelta(item) || 0));
  const strike = Number(getStrike(item));
  const expiry = getExpiration(item);

  const dist = distancePercent(
    strike,
    stockPrice
  );

  const dte =
    daysToExpiration(expiry);

  // قرب العقد من السعر
  if (dist !== null) {
    if (dist <= 0.5) score += 30;
    else if (dist <= 1) score += 25;
    else if (dist <= 2) score += 18;
    else if (dist <= 3) score += 10;
  }

  // دخول جديد
  if (volume > oi) score += 25;
  else if (volume > oi * 0.7) score += 15;
  else if (volume > oi * 0.4) score += 8;

  // حجم التداول
  if (volume >= 50000) score += 20;
  else if (volume >= 20000) score += 15;
  else if (volume >= 10000) score += 10;
  else if (volume >= 3000) score += 5;

  // OI
  if (oi >= 10000) score += 10;
  else if (oi >= 3000) score += 7;
  else if (oi >= 1000) score += 4;

  // Delta مناسبة
  if (delta >= 0.25 && delta <= 0.45) {
    score += 15;
  } else if (delta > 0.45 && delta <= 0.65) {
    score += 8;
  }

  // Gamma
  if (gamma >= 0.08) score += 15;
  else if (gamma >= 0.04) score += 10;
  else if (gamma >= 0.02) score += 5;

  // تاريخ قريب
  if (dte >= 0 && dte <= 7) score += 10;
  else if (dte <= 14) score += 5;

  return Math.min(score, 100);
}

function topContracts(chain, type, stockPrice, count = 3) {
  const maxDistancePercent = 3;

  return chain
    .filter(x => {
      const contractType = getContractType(x);

      if (contractType !== type) return false;

      const strike = Number(getStrike(x));

      if (isNaN(strike)) return false;

      const dist = distancePercent(
        strike,
        stockPrice
      );

      if (dist === null) return false;

      return dist <= maxDistancePercent;
    })
    .map(item => ({
      item,
      qScore: qualityScore(item, stockPrice)
    }))
    .sort((a, b) => b.qScore - a.qScore)
    .slice(0, count)
    .map(x => x.item);
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

function formatContracts(title, list, stockPrice) {
  if (!list.length) {
    return `${title}\nلا توجد بيانات متاحة\n`;
  }

  return `${title}\n\n` +
    list.map((x, i) => {
      const strike = getStrike(x);
      const dist = distancePercent(
        strike,
        stockPrice
      );

      const qScore =
        qualityScore(x, stockPrice);

      return `${i + 1}) Strike [${strike}]

📦 الحجم:
${fmt(getVolume(x))}

📂 OI:
${fmt(getOI(x))}

📅 الانتهاء:
${getExpiration(x)}

📍 بعده عن السعر:
${dist !== null ? dist.toFixed(2) + '%' : 'غير متوفر'}

⭐ جودة العقد:
${qScore}/100`;
    }).join('\n\n') + '\n';
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

function strongestFocus(calls, puts, stockPrice) {
  const strongest =
    getStrongestContract(calls, puts, stockPrice);

  if (!strongest) return 'غير متوفر';

  return `${strongest.side} ${getStrike(strongest.item)} | جودة ${strongest.qScore}/100`;
}

function strongestContractDetails(calls, puts, stockPrice) {
  const strongest =
    getStrongestContract(calls, puts, stockPrice);

  if (!strongest) {
    return `📊 بيانات العقد الأقوى:
غير متوفر`;
  }

  const item = strongest.item;

  const delta = getDelta(item);
  const gamma = getGamma(item);
  const iv = getIV(item);
  const theta = getTheta(item);
  const strike = getStrike(item);
  const dist = distancePercent(
    strike,
    stockPrice
  );

  return `📊 بيانات العقد الأقوى:

⭐ جودة العقد:
${strongest.qScore}/100

📍 قربه من السعر:
${dist !== null ? dist.toFixed(2) + '%' : 'غير متوفر'}

Δ Delta:
${
  delta !== undefined && delta !== null
    ? Number(delta).toFixed(2)
    : 'غير متوفر'
}

Γ Gamma:
${gammaText(gamma)}

IV:
${
  iv !== undefined && iv !== null
    ? fmtPercent(Number(iv) * 100)
    : 'غير متوفر'
}

Θ Theta:
${
  theta !== undefined && theta !== null
    ? Number(theta).toFixed(2)
    : 'غير متوفر'
}`;
}
function biasText(calls, puts, stockPrice) {

  const calcSide = (list) => {

    return list.reduce((sum, item) => {

      return (
        sum +
        qualityScore(item, stockPrice)
      );

    }, 0);
  };

  const totalCall =
    calcSide(calls);

  const totalPut =
    calcSide(puts);

  if (totalCall > totalPut * 1.25) {
    return '🟢 تدفق شرائي قوي';
  }

  if (totalPut > totalCall * 1.25) {
    return '🔴 تدفق بيعي قوي';
  }

  return '⚪ تدفق متوازن';
}

async function buildFlowMessage(symbol) {

  const cached = CACHE.get(symbol);

  if (
    cached &&
    nowSeconds() - cached.time <
    CACHE_SECONDS
  ) {
    return cached.message;
  }

  const stock =
    await getStockSnapshot(symbol);

  const chain =
    await getOptionsChain(symbol);

  if (!stock) {
    return `⚠️ تعذر جلب بيانات ${symbol}`;
  }

  const calls =
    topContracts(
      chain,
      'call',
      stock.price,
      3
    );

  const puts =
    topContracts(
      chain,
      'put',
      stock.price,
      3
    );

  const sr =
    nearestSupportResistance(stock);

  const momentum =
    momentumText(stock);

  const focus =
    strongestFocus(
      calls,
      puts,
      stock.price
    );

  const details =
    strongestContractDetails(
      calls,
      puts,
      stock.price
    );

  const bias =
    biasText(
      calls,
      puts,
      stock.price
    );

  const price =
    fmtPrice(stock.price);

  const change =
    stock.change !== null &&
    stock.change !== undefined
      ? fmtPercent(stock.change)
      : 'غير متوفر';

  let smartRead = '';

  const strongest =
    getStrongestContract(
      calls,
      puts,
      stock.price
    );

  if (strongest) {

    const item =
      strongest.item;

    const volume =
      getVolume(item);

    const oi =
      getOI(item);

    const gamma =
      Number(getGamma(item) || 0);

    const delta =
      Math.abs(
        Number(
          getDelta(item) || 0
        )
      );

    if (
      volume > oi &&
      gamma >= 0.04
    ) {

      smartRead =
`🚨 قراءة ذكية:
دخول سيولة جديدة قوية مع جاما مرتفعة واحتمال حركة سريعة.`;

    } else if (
      volume > oi
    ) {

      smartRead =
`📈 قراءة ذكية:
يوجد نشاط جديد ملحوظ على العقود الحالية.`;

    } else {

      smartRead =
`📊 قراءة ذكية:
التمركز الحالي يبدو أقرب إلى احتفاظ أو حماية وليس دخول هجومي قوي.`;
    }

    if (
      delta >= 0.25 &&
      delta <= 0.45
    ) {

      smartRead += `

🎯 العقد قريب من منطقة الحركة السريعة.`;
    }

  } else {

    smartRead =
`📊 قراءة ذكية:
لا توجد عقود قريبة كافية لتكوين قراءة واضحة حالياً.`;
  }

  const message =
`📊 تدفق عقود ${symbol}

💰 السعر الحالي:
${price}

📈 التغير:
${change}

🔥 الزخم:
${momentum}

━━━━━━━━━━━━━━

📍 المقاومة الأقرب:
${fmtPrice(sr.resistance)}

📍 الدعم الأقرب:
${fmtPrice(sr.support)}

━━━━━━━━━━━━━━

${formatContracts(
  '🟢 أعلى عقود CALL',
  calls,
  stock.price
)}

━━━━━━━━━━━━━━

${formatContracts(
  '🔴 أعلى عقود PUT',
  puts,
  stock.price
)}

━━━━━━━━━━━━━━

🔥 أقوى تمركز:
${focus}

${details}

━━━━━━━━━━━━━━

${smartRead}

━━━━━━━━━━━━━━

📍 الغلبة الحالية:
${bias}

⏱ التحديث:
كل 60 ثانية لمدة 5 دقائق`;

  CACHE.set(symbol, {
    time: nowSeconds(),
    message
  });

  return message;
}

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

    const { data: users, error } =
      await supabase
        .from('users_access')
        .select('*')
        .eq('active', true);

    if (error) {
      throw error;
    }

    for (const user of users || []) {

      if (!user.expires_at) {
        continue;
      }

      const expiry =
        new Date(user.expires_at);

      const alreadyNotified =
        user.notified_3_days === true;

      const isWithinWarning =
        expiry <= warningDate &&
        expiry > now;

      if (
        isWithinWarning &&
        !alreadyNotified
      ) {

        try {

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
            .eq(
              'telegram_id',
              user.telegram_id
            );

        } catch (err) {

          console.error(
            'Notification Error:',
            err.message
          );
        }
      }
    }

  } catch (err) {

    console.error(
      'Expiry Check Error:',
      err.message
    );
  }
}

function clearUpdate(chatId) {

  const active =
    activeUpdates.get(chatId);

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

      const msg =
        await buildFlowMessage(symbol);

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

async function sendFlow(chatId, symbol) {

  try {

    const access =
      await requireAccess(chatId);

    if (!access) return;

    const check =
      canRequest(chatId);

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

    const msg =
      await buildFlowMessage(symbol);

    await bot.sendMessage(
      chatId,
      msg
    );

    startAutoUpdate(chatId, symbol);

  } catch (err) {

    console.error(err);

    const message =
      String(err.message || '');

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

    if (
      message.includes(
        'Missing MASSIVE_API_KEY'
      )
    ) {

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

    const result =
      await redeemCode(
        msg.chat.id,
        match[1]
      );

    await bot.sendMessage(
      msg.chat.id,
      result.message
    );

  } catch (err) {

    console.error(err);

    await bot.sendMessage(
      msg.chat.id,
      `حدث خطأ أثناء التفعيل:\n${err.message}`
    );
  }
});

bot.onText(/\/status/, async (msg) => {

  try {

    const sub =
      await getUserAccess(msg.chat.id);

    if (!sub) {

      await bot.sendMessage(
        msg.chat.id,
`🔒 لا يوجد اشتراك فعال.

للتفعيل:
/redeem CODE`
      );

      return;
    }

    const active =
      await hasActiveAccess(msg.chat.id);

    await bot.sendMessage(
      msg.chat.id,
`${active ? '✅ اشتراكك فعال' : '❌ اشتراكك منتهي'}

الكود المستخدم:
${sub.code_used || 'غير متوفر'}

ينتهي في:
${formatDate(sub.expires_at)}`
    );

  } catch (err) {

    console.error(err);

    await bot.sendMessage(
      msg.chat.id,
      `حدث خطأ:\n${err.message}`
    );
  }
});

bot.onText(/\/gencode(?:\s+(\d+))?/, async (msg, match) => {

  try {

    if (!isAdmin(msg.chat.id)) {

      await bot.sendMessage(
        msg.chat.id,
        '⛔ هذا الأمر للأدمن فقط.'
      );

      return;
    }

    const days =
      Number(match[1] || 30);

    const result =
      await createActivationCode(days);

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

  } catch (err) {

    console.error(err);

    await bot.sendMessage(
      msg.chat.id,
      `حدث خطأ:\n${err.message}`
    );
  }
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

  if (text.startsWith('/')) {
    return;
  }

  const symbol =
    text.trim().toUpperCase();

  const valid =
    /^[A-Z]{1,5}$/.test(symbol);

  if (!valid) {

    await bot.sendMessage(
      msg.chat.id,
`⚠️ الرمز غير صحيح.

أمثلة صحيحة:

TSLA
AAPL
NVDA
AMD
SPY`
    );

    return;
  }

  sendFlow(msg.chat.id, symbol);
});

checkExpiringSubscriptions();

setInterval(() => {
  checkExpiringSubscriptions();
}, CHECK_EXPIRY_INTERVAL);

console.log(
  'ST Flow Stocks bot running...'
);
