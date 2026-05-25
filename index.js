const TelegramBot = require('node-telegram-bot-api');
const { createClient } = require('@supabase/supabase-js');

const bot = new TelegramBot(process.env.BOT_TOKEN, {
  polling: true
});

const API_KEY = process.env.MASSIVE_API_KEY;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const ADMIN_IDS = String(process.env.ADMIN_IDS || '')
  .split(',')
  .map(x => x.trim())
  .filter(Boolean);

const supabase = createClient(
  SUPABASE_URL,
  SUPABASE_SERVICE_KEY
);

const userCooldown = new Map();
const CACHE = new Map();
const activeUpdates = new Map();

const USER_COOLDOWN_SECONDS = 10;
const CACHE_SECONDS = 60;
const UPDATE_INTERVAL_MS = 60 * 1000;
const UPDATE_DURATION_MS = 5 * 60 * 1000;

const EXPIRY_WARNING_DAYS = 3;
const CHECK_EXPIRY_INTERVAL =
  12 * 60 * 60 * 1000;

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

  if (!v) {
    return 'غير متوفر';
  }

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

  const chars =
    'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

  let code = 'ST-';

  for (let i = 0; i < 4; i++) {
    code += chars[
      Math.floor(Math.random() * chars.length)
    ];
  }

  code += '-';

  for (let i = 0; i < 4; i++) {
    code += chars[
      Math.floor(Math.random() * chars.length)
    ];
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

  if (error) {
    throw error;
  }

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

  if (
    error &&
    error.code !== 'PGRST116'
  ) {
    throw error;
  }

  return data || null;
}

async function hasActiveAccess(chatId) {

  const user =
    await getUserAccess(chatId);

  if (!user) return false;
  if (!user.active) return false;
  if (!user.expires_at) return false;

  return (
    new Date(user.expires_at).getTime() >
    Date.now()
  );
}

async function requireAccess(chatId) {

  const access =
    await hasActiveAccess(chatId);

  if (access) {
    return true;
  }

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

  const {
    data: activation,
    error
  } = await supabase
    .from('activation_codes')
    .select('*')
    .eq('code', cleanCode)
    .single();

  if (error || !activation) {

    return {
      ok: false,
      message:
        '❌ كود التفعيل غير صحيح.'
    };
  }

  if (activation.used) {

    return {
      ok: false,
      message:
        '⚠️ هذا الكود مستخدم مسبقًا.'
    };
  }

  const expiresAt = activation.expires_at;

  if (
    !expiresAt ||
    new Date(expiresAt).getTime() <
      Date.now()
  ) {

    return {
      ok: false,
      message:
        '⚠️ هذا الكود منتهي الصلاحية.'
    };
  }

  const { error: updateError } =
    await supabase
      .from('activation_codes')
      .update({
        used: true,
        telegram_id: String(chatId),
        activated_at: nowIso()
      })
      .eq('code', cleanCode)
      .eq('used', false);

  if (updateError) {
    throw updateError;
  }

  const { error: userError } =
    await supabase
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

  if (userError) {
    throw userError;
  }

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

  if (
    n === undefined ||
    n === null ||
    isNaN(Number(n))
  ) {
    return 'غير متوفر';
  }

  return Number(n).toLocaleString('en-US');
}

function fmtPrice(n) {

  if (
    n === undefined ||
    n === null ||
    isNaN(Number(n))
  ) {
    return 'غير متوفر';
  }

  return Number(n).toFixed(2);
}

function fmtPercent(n) {

  if (
    n === undefined ||
    n === null ||
    isNaN(Number(n))
  ) {
    return 'غير متوفر';
  }

  return `${Number(n).toFixed(2)}%`;
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function canRequest(chatId) {

  const last =
    userCooldown.get(chatId) || 0;

  const diff =
    nowSeconds() - last;

  if (diff < USER_COOLDOWN_SECONDS) {

    return {
      ok: false,
      wait:
        USER_COOLDOWN_SECONDS - diff
    };
  }

  userCooldown.set(
    chatId,
    nowSeconds()
  );

  return { ok: true };
}

async function apiGet(url) {

  if (!API_KEY) {
    throw new Error(
      'Missing MASSIVE_API_KEY'
    );
  }

  const res = await fetch(url);

  const data = await res.json();

  if (!res.ok) {

    throw new Error(
      data?.error ||
      data?.message ||
      'API Error'
    );
  }

  return data;
}

async function getStockSnapshot(symbol) {

  const url =
`https://api.massive.com/v2/aggs/ticker/${symbol}/prev?adjusted=true&apiKey=${API_KEY}`;

  const data = await apiGet(url);

  const r = data?.results?.[0];

  if (!r) {
    return null;
  }

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

  const data =
    await apiGet(url);

  return data.results || [];
}

function getContractType(item) {
  return String(
    item?.details?.contract_type || ''
  ).toLowerCase();
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

  if (
    gamma === undefined ||
    gamma === null ||
    isNaN(g)
  ) {
    return 'غير متوفر';
  }

  if (g >= 0.08) {
    return 'مرتفع جدًا';
  }

  if (g >= 0.04) {
    return 'مرتفع';
  }

  if (g >= 0.02) {
    return 'متوسط';
  }

  return 'منخفض';
}

function scoreContract(item) {
  return (
    getVolume(item) +
    getOI(item)
  );
}

function topContracts(
  chain,
  type,
  count = 3
) {

  return chain
    .filter(
      x =>
        getContractType(x) === type
    )
    .sort(
      (a, b) =>
        scoreContract(b) -
        scoreContract(a)
    )
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

  if (
    !stock ||
    stock.change === null ||
    stock.change === undefined
  ) {
    return 'غير متوفر';
  }

  if (stock.change > 1) {
    return '🔥 صاعد قوي';
  }

  if (stock.change > 0) {
    return '🟢 صاعد';
  }

  if (stock.change < -1) {
    return '🔴 هابط قوي';
  }

  if (stock.change < 0) {
    return '🔴 هابط';
  }

  return '⚪ محايد';
}

function formatContracts(title, list) {

  if (!list.length) {

    return `${title}

⚠️ لا توجد بيانات متاحة حالياً.

لم يتم تفعيل اشتراك البيانات المباشرة للمالك بعد.
`;
  }

  return (
`${title}

` +

list.map((x, i) =>
`${i + 1}) Strike [${getStrike(x)}]

📦 الحجم:
${fmt(getVolume(x))}

📂 OI:
${fmt(getOI(x))}

📅 الانتهاء:
${getExpiration(x)}`
).join('\n\n')

+ '\n'
  );
}

function getStrongestContract(
  calls,
  puts
) {

  const all = [
    ...calls.map(x => ({
      item: x,
      side: 'CALL'
    })),

    ...puts.map(x => ({
      item: x,
      side: 'PUT'
    }))
  ];

  if (!all.length) {
    return null;
  }

  all.sort(
    (a, b) =>
      scoreContract(b.item) -
      scoreContract(a.item)
  );

  return all[0];
}

function strongestFocus(
  calls,
  puts
) {

  const strongest =
    getStrongestContract(
      calls,
      puts
    );

  if (!strongest) {
    return 'غير متوفر';
  }

  return `
${strongest.side}
${getStrike(strongest.item)}
`;
}

function strongestContractDetails(
  calls,
  puts
) {

  const strongest =
    getStrongestContract(
      calls,
      puts
    );

  if (!strongest) {

    return `📊 بيانات العقد الأقوى:
غير متوفر`;
  }

  const item =
    strongest.item;

  const delta =
    getDelta(item);

  const gamma =
    getGamma(item);

  const iv =
    getIV(item);

  const theta =
    getTheta(item);

  return `
📊 بيانات العقد الأقوى

Δ Delta:
${
  delta !== undefined &&
  delta !== null
    ? Number(delta).toFixed(2)
    : 'غير متوفر'
}

Γ Gamma:
${gammaText(gamma)}

IV:
${
  iv !== undefined &&
  iv !== null
    ? fmtPercent(Number(iv) * 100)
    : 'غير متوفر'
}

Θ Theta:
${
  theta !== undefined &&
  theta !== null
    ? Number(theta).toFixed(2)
    : 'غير متوفر'
}
`;
}

function biasText(
  calls,
  puts
) {

  const totalCall =
    calls.reduce(
      (s, x) =>
        s + scoreContract(x),
      0
    );

  const totalPut =
    puts.reduce(
      (s, x) =>
        s + scoreContract(x),
      0
    );

  if (totalCall > totalPut) {
    return '🟢 الكول أقوى';
  }

  if (totalPut > totalCall) {
    return '🔴 البوت أقوى';
  }

  return '⚪ متوازن';
}

async function buildFlowMessage(symbol) {

  const cached =
    CACHE.get(symbol);

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

  const calls =
    topContracts(chain, 'call', 3);

  const puts =
    topContracts(chain, 'put', 3);

  const sr =
    nearestSupportResistance(stock);

  const momentum =
    momentumText(stock);

  const focus =
    strongestFocus(
      calls,
      puts
    );

  const details =
    strongestContractDetails(
      calls,
      puts
    );

  const bias =
    biasText(
      calls,
      puts
    );

  const price = stock
    ? fmtPrice(stock.price)
    : 'غير متوفر';

  const change =
    stock &&
    stock.change !== null &&
    stock.change !== undefined
      ? fmtPercent(stock.change)
      : 'غير متوفر';

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
  calls
)}

━━━━━━━━━━━━━━

${formatContracts(
  '🔴 أعلى عقود PUT',
  puts
)}

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
