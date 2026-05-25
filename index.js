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
        active: true
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

function scoreContract(item) {
  return getVolume(item) + getOI(item);
}
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

  const change = r.o ? ((r.c - r.o) / r.o) * 100 : null;

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

function topContracts(chain, type, count = 3) {
  return chain
    .filter(x => getContractType(x) === type)
    .sort((a, b) => scoreContract(b) - scoreContract(a))
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

function formatContracts(title, list) {
  if (!list.length) {
    return `${title}\nلا توجد بيانات متاحة\n`;
  }

  return `${title}\n\n` +
    list.map((x, i) =>
`${i + 1}) Strike [${getStrike(x)}]
📦 الحجم: ${fmt(getVolume(x))}
📂 OI: ${fmt(getOI(x))}
📅 الانتهاء: ${getExpiration(x)}`
    ).join('\n\n') + '\n';
}

function getStrongestContract(calls, puts) {
  const all = [
    ...calls.map(x => ({ item: x, side: 'CALL' })),
    ...puts.map(x => ({ item: x, side: 'PUT' }))
  ];

  if (!all.length) return null;

  all.sort((a, b) => scoreContract(b.item) - scoreContract(a.item));
  return all[0];
}

function strongestFocus(calls, puts) {
  const strongest = getStrongestContract(calls, puts);

  if (!strongest) return 'غير متوفر';

  return `${strongest.side} ${getStrike(strongest.item)}`;
}

function strongestContractDetails(calls, puts) {
  const strongest = getStrongestContract(calls, puts);

  if (!strongest) {
    return `📊 بيانات العقد الأقوى:
غير متوفر`;
  }

  const item = strongest.item;
  const delta = getDelta(item);
  const gamma = getGamma(item);
  const iv = getIV(item);
  const theta = getTheta(item);

  return `📊 بيانات العقد الأقوى:
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
  }`;
}

function biasText(calls, puts) {
  const totalCall = calls.reduce((s, x) => s + scoreContract(x), 0);
  const totalPut = puts.reduce((s, x) => s + scoreContract(x), 0);

  if (totalCall > totalPut) return '🟢 الكول أقوى';
  if (totalPut > totalCall) return '🔴 البوت أقوى';

  return '⚪ متوازن';
}

async function buildFlowMessage(symbol) {
  const cached = CACHE.get(symbol);

  if (cached && nowSeconds() - cached.time < CACHE_SECONDS) {
    return cached.message;
  }

  const stock = await getStockSnapshot(symbol);
  const chain = await getOptionsChain(symbol);

  const calls = topContracts(chain, 'call', 3);
  const puts = topContracts(chain, 'put', 3);

  const sr = nearestSupportResistance(stock);
  const momentum = momentumText(stock);
  const focus = strongestFocus(calls, puts);
  const details = strongestContractDetails(calls, puts);
  const bias = biasText(calls, puts);

  const price = stock ? fmtPrice(stock.price) : 'غير متوفر';

  const change =
    stock && stock.change !== null && stock.change !== undefined
      ? fmtPercent(stock.change)
      : 'غير متوفر';

  const message =
`📊 تدفق عقود ${symbol}

💰 السعر الحالي: ${price}
📈 التغير: ${change}
🔥 الزخم: ${momentum}

📍 المقاومة الأقرب:
${fmtPrice(sr.resistance)}

📍 الدعم الأقرب:
${fmtPrice(sr.support)}

⚠️ اختراق المقاومة = استمرار صعود
⚠️ كسر الدعم = ضعف واحتمال هبوط

━━━━━━━━━━━━━━

${formatContracts('🟢 أعلى 3 عقود CALL', calls)}

━━━━━━━━━━━━━━

${formatContracts('🔴 أعلى 3 عقود PUT', puts)}

━━━━━━━━━━━━━━

🔥 أقوى تمركز:
${focus}

${details}

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

function clearUpdate(chatId) {
  const active = activeUpdates.get(chatId);

  if (active?.intervalId) clearInterval(active.intervalId);
  if (active?.timeoutId) clearTimeout(active.timeoutId);

  activeUpdates.delete(chatId);
}

function startAutoUpdate(chatId, symbol) {
  clearUpdate(chatId);

  const intervalId = setInterval(async () => {
    try {
      const msg = await buildFlowMessage(symbol);
      await bot.sendMessage(chatId, msg);
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

    await bot.sendMessage(chatId, `⏳ جاري جلب بيانات ${symbol}...`);

    const msg = await buildFlowMessage(symbol);

    await bot.sendMessage(chatId, msg);

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
`⚠️ اشتراك Massive الحالي لا يدعم بيانات الأوبشن.

الخطة الحالية لا تسمح بسحب:

Options Chain
Options Snapshot`
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

    await bot.sendMessage(chatId, `حدث خطأ:\n${message}`);
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
/redeem ST-ABCD-1234

بعد التفعيل:
اكتب رمز الشركة مباشرة مثل:

TSLA
AAPL
NVDA
AMD
SPY`
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
    const result = await redeemCode(msg.chat.id, match[1]);

    await bot.sendMessage(msg.chat.id, result.message);
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
      await bot.sendMessage(msg.chat.id, '⛔ هذا الأمر للأدمن فقط.');
      return;
    }

    const days = Number(match[1] || 30);

    if (!Number.isFinite(days) || days <= 0) {
      await bot.sendMessage(
        msg.chat.id,
        '⚠️ اكتب مدة صحيحة. مثال: /gencode 30'
      );
      return;
    }

    const result = await createActivationCode(days);

    await bot.sendMessage(
      msg.chat.id,
`✅ تم إنشاء كود جديد

الكود:
${result.code}

المدة:
${days} يوم

ينتهي الكود في:
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

  if (text.startsWith('/')) return;

  const symbol = text.trim().toUpperCase();

  const valid = /^[A-Z]{1,5}$/.test(symbol);

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

console.log('ST Flow Stocks bot running...');
