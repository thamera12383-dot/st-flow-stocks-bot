const TelegramBot = require('node-telegram-bot-api');

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });

let TARGET_CHAT_ID = process.env.CHANNEL_ID || null;

const WATCHLIST = ['TSLA', 'NVDA', 'META', 'AMZN', 'SPY', 'QQQ'];

async function sendTrade(trade) {
  if (!TARGET_CHAT_ID) return;

  const caption =
`🚨 صفقة عالية الجودة

📊 السهم: ${trade.symbol}
📈 الاتجاه: ${trade.side}

🎯 العقد:
${trade.strike} ${trade.side}

📅 الانتهاء:
${trade.expiration}

━━━━━━━━━━━━━━

💰 الدخول: ${trade.entry}
📍 السعر الحالي: ${trade.last}

🟢 TP1: ${trade.tp1}
🟢 TP2: ${trade.tp2}

🔴 SL: ${trade.sl}

━━━━━━━━━━━━━━

📦 Volume: ${trade.volume}
📂 OI: ${trade.oi}

⭐ Score: ${trade.score}/100

⚠️ ليست توصية مالية`;

  const imageUrl =
    trade.side === 'CALL'
      ? 'https://i.imgur.com/8QZ7Z6F.png'
      : 'https://i.imgur.com/L6X4K7C.png';

  await bot.sendPhoto(TARGET_CHAT_ID, imageUrl, {
    caption
  });
}

function fakeScanner() {
  const symbol = WATCHLIST[Math.floor(Math.random() * WATCHLIST.length)];

  return {
    symbol,
    side: Math.random() > 0.5 ? 'CALL' : 'PUT',
    strike: symbol === 'SPY' ? '590' : '440',
    expiration: '2026-05-30',
    entry: '1.50',
    last: '1.48',
    tp1: '1.70',
    tp2: '1.90',
    sl: '1.20',
    oi: '18,200',
    volume: '12,430',
    score: 88
  };
}

bot.onText(/\/start/, async (msg) => {
  TARGET_CHAT_ID = msg.chat.id;

  await bot.sendMessage(
    msg.chat.id,
`🚀 ST Flow Signals يعمل الآن

البوت سيرسل صفقات تلقائية عند تحقق الشروط.

للتجربة:
/test`
  );
});

bot.onText(/\/test/, async (msg) => {
  TARGET_CHAT_ID = msg.chat.id;

  const trade = fakeScanner();

  await sendTrade(trade);
});

setInterval(async () => {
  if (!TARGET_CHAT_ID) return;

  const shouldSend = Math.random() > 0.75;

  if (!shouldSend) return;

  const trade = fakeScanner();

  await sendTrade(trade);

}, 5 * 60 * 1000);

console.log('ST Flow Signals running...');
