const TelegramBot = require('node-telegram-bot-api');

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });
const API_KEY = process.env.MASSIVE_API_KEY;

function fmt(n) {
  if (n === undefined || n === null || isNaN(n)) return 'غير متوفر';
  return Number(n).toLocaleString('en-US');
}

function cleanSymbol(text) {
  return text.replace('/flow', '').trim().toUpperCase();
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

function scoreContract(item) {
  return getVolume(item) + getOI(item);
}

async function getOptionsChain(symbol) {
  const url = `https://api.massive.com/v3/snapshot/options/${symbol}?limit=250&apiKey=${API_KEY}`;
  const res = await fetch(url);
  const data = await res.json();

  if (!res.ok) {
    throw new Error(data?.error || data?.message || 'API Error');
  }

  return data.results || [];
}

function topContracts(chain, type, count = 3) {
  return chain
    .filter(x => getContractType(x).toLowerCase() === type)
    .sort((a, b) => scoreContract(b) - scoreContract(a))
    .slice(0, count);
}

function formatContracts(title, list) {
  if (!list.length) return `${title}\nلا توجد بيانات متاحة\n`;

  return `${title}\n` + list.map((x, i) =>
`${i + 1}) Strike [${getStrike(x)}]
   الحجم: ${fmt(getVolume(x))}
   العقود المفتوحة OI: ${fmt(getOI(x))}
   الانتهاء: ${getExpiration(x)}`
  ).join('\n\n') + '\n';
}

async function sendOptionsUpdate(chatId, symbol) {
  try {
    await bot.sendMessage(chatId, `⏳ جاري جلب بيانات عقود ${symbol}...`);

    const chain = await getOptionsChain(symbol);

    if (!chain.length) {
      await bot.sendMessage(chatId, `لم أجد بيانات أوبشن لـ ${symbol}`);
      return;
    }

    const calls = topContracts(chain, 'call', 3);
    const puts = topContracts(chain, 'put', 3);

    const totalCallVol = calls.reduce((s, x) => s + getVolume(x), 0);
    const totalPutVol = puts.reduce((s, x) => s + getVolume(x), 0);

    const bias =
      totalCallVol > totalPutVol ? '🟢 الكول أقوى' :
      totalPutVol > totalCallVol ? '🔴 البوت أقوى' :
      '⚪ متوازن';

    const msg =
`📊 ملخص عقود ${symbol}

${formatContracts('🟢 أعلى 3 كول', calls)}
--------------------
${formatContracts('🔴 أعلى 3 بوت', puts)}
--------------------
📍 قراءة سريعة:
الغلبة حسب أعلى العقود: ${bias}

⚠️ بيانات الخطة المجانية قد تكون محدودة أو غير لحظية بالكامل.`;

    await bot.sendMessage(chatId, msg);
  } catch (err) {
    console.error(err);
    await bot.sendMessage(chatId, `حدث خطأ أثناء جلب بيانات ${symbol}.\n${err.message}`);
  }
}

bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id,
`🚀 مرحبًا بك في ST Flow Stocks

اكتب:
/flow TSLA
/flow NVDA
/flow AAPL
/flow AMD

/help للمساعدة`);
});

bot.onText(/\/flow (.+)/, (msg) => {
  const symbol = cleanSymbol(msg.text);

  if (!symbol) {
    bot.sendMessage(msg.chat.id, 'اكتب الرمز بهذا الشكل:\n/flow TSLA');
    return;
  }

  sendOptionsUpdate(msg.chat.id, symbol);
});

bot.onText(/\/help/, (msg) => {
  bot.sendMessage(msg.chat.id,
`❓ طريقة الاستخدام:

اكتب:
/flow TSLA
/flow NVDA
/flow AAPL
/flow AMD

البوت يعرض أعلى 3 كول وأعلى 3 بوت حسب البيانات المتاحة.`);
});

console.log('ST Flow Stocks bot is running...');
