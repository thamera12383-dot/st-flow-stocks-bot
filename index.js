const TelegramBot = require('node-telegram-bot-api');

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });
const API_KEY = process.env.MASSIVE_API_KEY;

const userCooldown = new Map();
const CACHE = new Map();

const USER_COOLDOWN_SECONDS = 10;
const CACHE_SECONDS = 60;

function fmt(n) {
  if (n === undefined || n === null || isNaN(n)) return 'غير متوفر';
  return Number(n).toLocaleString('en-US');
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
  return item?.details?.contract_type || '';
}

function getStrike(item) {
  return item?.details?.strike_price;
}

function getVolume(item) {
  return item?.day?.volume || 0;
}

function getOI(item) {
  return item?.open_interest || 0;
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

function scoreContract(item) {
  return getVolume(item) + getOI(item);
}

async function apiGet(url) {
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
    .filter(x => getContractType(x).toLowerCase() === type)
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
📂 العقود المفتوحة OI: ${fmt(getOI(x))}
📅 الانتهاء: ${getExpiration(x)}
IV: ${fmt(getIV(x))}
Delta: ${fmt(getDelta(x))}`

).join('\n\n') + '\n';
}

function strongestFocus(calls, puts) {

  const all = [
    ...calls.map(x => ({ ...x, side: 'CALL' })),
    ...puts.map(x => ({ ...x, side: 'PUT' }))
  ];

  if (!all.length) return 'غير متوفر';

  all.sort((a, b) => scoreContract(b) - scoreContract(a));

  const top = all[0];

  return `${top.side} ${getStrike(top)}`;
}

function biasText(calls, puts) {

  const totalCall = calls.reduce(
    (s, x) => s + scoreContract(x),
    0
  );

  const totalPut = puts.reduce(
    (s, x) => s + scoreContract(x),
    0
  );

  if (totalCall > totalPut) return '🟢 الكول أقوى';

  if (totalPut > totalCall) return '🔴 البوت أقوى';

  return '⚪ متوازن';
}

async function buildFlowMessage(symbol) {

  const cached = CACHE.get(symbol);

  if (
    cached &&
    nowSeconds() - cached.time < CACHE_SECONDS
  ) {
    return cached.message;
  }

  const stock = await getStockSnapshot(symbol);

  const chain = await getOptionsChain(symbol);

  const calls = topContracts(chain, 'call', 3);

  const puts = topContracts(chain, 'put', 3);

  const sr = nearestSupportResistance(stock);

  const momentum = momentumText(stock);

  const focus = strongestFocus(calls, puts);

  const bias = biasText(calls, puts);

  const price = stock
    ? fmt(stock.price)
    : 'غير متوفر';

  const change =
    stock &&
    stock.change !== null &&
    stock.change !== undefined
      ? `${stock.change.toFixed(2)}%`
      : 'غير متوفر';

  const message =

`📊 تدفق عقود ${symbol}

💰 السعر الحالي: ${price}
📈 التغير: ${change}
🔥 الزخم: ${momentum}
📍 المقاومة الأقرب: ${fmt(sr.resistance)}
📍 الدعم الأقرب: ${fmt(sr.support)}

⚠️ اختراق ${fmt(sr.resistance)} = استمرار صعود
⚠️ كسر ${fmt(sr.support)} = ضعف واحتمال هبوط

━━━━━━━━━━━━━━

${formatContracts('🟢 أعلى 3 عقود CALL', calls)}

━━━━━━━━━━━━━━

${formatContracts('🔴 أعلى 3 عقود PUT', puts)}

━━━━━━━━━━━━━━

🔥 أقوى تمركز:
${focus}

📍 الغلبة الحالية:
${bias}

⏱ تحديث كل 60 ثانية لمدة 5 دقائق`;

  CACHE.set(symbol, {
    time: nowSeconds(),
    message
  });

  return message;
}

async function sendFlow(chatId, symbol) {

  try {

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

    await bot.sendMessage(chatId, msg);

  } catch (err) {

    console.error(err);

    const entitlement =
      err.message.includes('not entitled') ||
      err.message.includes('entitled');

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

    await bot.sendMessage(
      chatId,
      `حدث خطأ أثناء جلب بيانات ${symbol}\n${err.message}`
    );
  }
}

// START
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

// HELP
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
QQQ`
  );
});

// STOP
bot.onText(/\/stop/, (msg) => {

  bot.sendMessage(
    msg.chat.id,
    '🛑 تم إيقاف التحديثات.'
  );
});

// CHANGE
bot.onText(/\/change/, (msg) => {

  bot.sendMessage(
    msg.chat.id,
    '🔄 اكتب رمز شركة جديد.'
  );
});

// ANY MESSAGE
bot.on('message', async (msg) => {

  const text = msg.text;

  if (!text) return;

  // تجاهل الأوامر
  if (text.startsWith('/')) return;

  const symbol = text
    .trim()
    .toUpperCase();

  // تحقق من شكل الرمز
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

  // جلب البيانات
  sendFlow(msg.chat.id, symbol);

});

console.log('ST Flow Stocks bot is running...');
