const TelegramBot = require('node-telegram-bot-api');

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });
const API_KEY = process.env.MASSIVE_API_KEY;

const userCooldown = new Map();
const CACHE = new Map();
const activeUpdates = new Map();

const USER_COOLDOWN_SECONDS = 10;
const CACHE_SECONDS = 60;
const UPDATE_INTERVAL_MS = 60 * 1000;
const UPDATE_DURATION_MS = 5 * 60 * 1000;

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
    return { ok: false, wait: USER_COOLDOWN_SECONDS - diff };
  }

  userCooldown.set(chatId, nowSeconds());
  return { ok: true };
}

function getContractType(item) {
  return String(item?.details?.contract_type || '').toLowerCase();
}

function getStrike(item) {
  return item?.details?.strike_price ?? 'غير متوفر';
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
  if (gamma === undefined || gamma === null || isNaN(g)) return 'غير متوفر';
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
  const url = `https://api.massive.com/v2/aggs/ticker/${symbol}/prev?adjusted=true&apiKey=${API_KEY}`;
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
    `https://api.massive.com/v3/snapshot/options/${symbol}` +
    `?limit=250&apiKey=${API_KEY}`;

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
Δ Delta: ${delta !== undefined && delta !== null ? Number(delta).toFixed(2) : 'غير متوفر'}
Γ Gamma: ${gammaText(gamma)}
IV: ${iv !== undefined && iv !== null ? fmtPercent(Number(iv) * 100) : 'غير متوفر'}
Θ Theta: ${theta !== undefined && theta !== null ? Number(theta).toFixed(2) : 'غير متوفر'}`;
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
📍 المقاومة الأقرب: ${fmtPrice(sr.resistance)}
📍 الدعم الأقرب: ${fmtPrice(sr.support)}

⚠️ اختراق ${fmtPrice(sr.resistance)} = استمرار صعود
⚠️ كسر ${fmtPrice(sr.support)} = ضعف واحتمال هبوط

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
      await bot.sendMessage(chatId, msg);
    } catch (err) {
      console.error(err);
      await bot.sendMessage(chatId, `⚠️ تعذر تحديث بيانات ${symbol}\n${err.message}`);
      clearUpdate(chatId);
    }
  }, UPDATE_INTERVAL_MS);

  const timeoutId = setTimeout(async () => {
    clearUpdate(chatId);
    await bot.sendMessage(chatId, `✅ انتهت متابعة ${symbol} التلقائية لمدة 5 دقائق.`);
  }, UPDATE_DURATION_MS);

  activeUpdates.set(chatId, { symbol, intervalId, timeoutId });
}

async function sendFlow(chatId, symbol) {
  try {
    const check = canRequest(chatId);

    if (!check.ok) {
      await bot.sendMessage(chatId, `⏳ انتظر ${check.wait} ثواني قبل طلب جديد.`);
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
`⚠️ بيانات الأوبشن غير مفعلة في الاشتراك الحالي.

الخطة الحالية لا تسمح بسحب:
Options Chain / Options Snapshot

بعد تفعيل اشتراك الأوبشن سيعمل البوت مباشرة.`
      );
      return;
    }

    if (message.includes('Missing MASSIVE_API_KEY')) {
      await bot.sendMessage(
        chatId,
`⚠️ مفتاح MASSIVE_API_KEY غير موجود.

أضفه في Railway:
Variables → New Variable

الاسم:
MASSIVE_API_KEY`
      );
      return;
    }

    await bot.sendMessage(
      chatId,
      `حدث خطأ أثناء جلب بيانات ${symbol}\n${message}`
    );
  }
}

bot.onText(/\/start/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
`🚀 مرحبًا بك في ST Flow Stocks

فقط اكتب رمز الشركة مباشرة:

TSLA
AAPL
NVDA
AMD
SPY
QQQ

وسيتم عرض:
🟢 أعلى عقود CALL
🔴 أعلى عقود PUT
📂 العقود المفتوحة OI
📦 الحجم
🔥 أقوى تمركز
📍 الغلبة الحالية`
  );
});

bot.onText(/\/help/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
`❓ طريقة الاستخدام

اكتب فقط رمز الشركة مثل:

TSLA
AAPL
NVDA
AMD
SPY
QQQ

لإيقاف التحديث:
 /stop`
  );
});

bot.onText(/\/stop/, (msg) => {
  clearUpdate(msg.chat.id);

  bot.sendMessage(
    msg.chat.id,
    '🛑 تم إيقاف التحديثات.'
  );
});

bot.onText(/\/change/, (msg) => {
  clearUpdate(msg.chat.id);

  bot.sendMessage(
    msg.chat.id,
    '🔄 اكتب رمز شركة جديد.'
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
`⚠️ الرمز غير معروف.

اكتب رمز شركة صحيح مثل:

TSLA
AAPL
NVDA
AMD
SPY
QQQ`
    );
    return;
  }

  sendFlow(msg.chat.id, symbol);
});

console.log('ST Flow Stocks bot is running...');
