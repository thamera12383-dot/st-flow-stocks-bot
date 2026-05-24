const TelegramBot = require('node-telegram-bot-api');

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });
const API_KEY = process.env.MASSIVE_API_KEY;

async function getStockPrice(symbol) {
  const url = `https://api.massive.com/v2/aggs/ticker/${symbol}/prev?adjusted=true&apiKey=${API_KEY}`;
  const res = await fetch(url);
  const data = await res.json();

  if (!data.results || data.results.length === 0) {
    return null;
  }

  const r = data.results[0];
  return {
    symbol,
    close: r.c,
    high: r.h,
    low: r.l,
    volume: r.v
  };
}

async function sendStockUpdate(chatId, symbol) {
  try {
    const data = await getStockPrice(symbol);

    if (!data) {
      bot.sendMessage(chatId, `لم أجد بيانات لـ ${symbol}`);
      return;
    }

    bot.sendMessage(chatId, `
📊 تحديث ${data.symbol}

السعر السابق: ${data.close}
أعلى سعر: ${data.high}
أقل سعر: ${data.low}
الحجم: ${data.volume}

⚠️ هذه بيانات الخطة المجانية وقد تكون نهاية يوم وليست لحظية.
`);
  } catch (error) {
    bot.sendMessage(chatId, 'حدث خطأ أثناء جلب البيانات.');
    console.error(error);
  }
}

bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id, `
🚀 تم تشغيل بوت ST Flow Stocks

استخدم:
/tsla
/nvda
/aapl
/amd
/help
`);
});

bot.onText(/\/stocks/, (msg) => {
  bot.sendMessage(msg.chat.id, `
📊 قائمة الشركات:

/tsla - تسلا
/nvda - نفيديا
/aapl - آبل
/amd - AMD
`);
});

bot.onText(/\/tsla/, (msg) => sendStockUpdate(msg.chat.id, 'TSLA'));
bot.onText(/\/nvda/, (msg) => sendStockUpdate(msg.chat.id, 'NVDA'));
bot.onText(/\/aapl/, (msg) => sendStockUpdate(msg.chat.id, 'AAPL'));
bot.onText(/\/amd/, (msg) => sendStockUpdate(msg.chat.id, 'AMD'));

bot.onText(/\/stop/, (msg) => {
  bot.sendMessage(msg.chat.id, '🛑 تم إيقاف التحديثات.');
});

bot.onText(/\/change/, (msg) => {
  bot.sendMessage(msg.chat.id, '🔄 اختر شركة من القائمة: /stocks');
});

bot.onText(/\/help/, (msg) => {
  bot.sendMessage(msg.chat.id, `
❓ المساعدة

/tsla تحديث تسلا
/nvda تحديث نفيديا
/aapl تحديث آبل
/amd تحديث AMD
/stocks قائمة الشركات
/stop إيقاف
`);
});

console.log('Bot is running...');
