const TelegramBot = require('node-telegram-bot-api');
const { createCanvas } = require('canvas');

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });

let TARGET_CHAT_ID = process.env.CHANNEL_ID || null;

const WATCHLIST = ['TSLA', 'NVDA', 'META', 'AMZN', 'SPY', 'QQQ'];

function createTradeCard(trade) {
  const canvas = createCanvas(900, 520);
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, 900, 520);

  ctx.fillStyle = trade.side === 'CALL' ? '#0b8f3a' : '#b00020';
  ctx.fillRect(0, 0, 900, 18);

  ctx.fillStyle = '#111827';
  ctx.font = 'bold 42px Arial';
  ctx.fillText(`${trade.symbol} ${trade.strike} ${trade.side}`, 45, 80);

  ctx.font = '26px Arial';
  ctx.fillStyle = '#6b7280';
  ctx.fillText(`Expiration: ${trade.expiration}`, 45, 122);

  ctx.fillStyle = '#111827';
  ctx.font = 'bold 34px Arial';
  ctx.fillText(`Entry: ${trade.entry}`, 45, 190);
  ctx.fillText(`Last: ${trade.last}`, 350, 190);

  ctx.fillStyle = '#2563eb';
  ctx.fillText(`Bid: ${trade.bid}`, 45, 250);
  ctx.fillStyle = '#dc2626';
  ctx.fillText(`Ask: ${trade.ask}`, 350, 250);

  ctx.fillStyle = '#111827';
  ctx.font = '28px Arial';
  ctx.fillText(`TP1: ${trade.tp1}`, 45, 315);
  ctx.fillText(`TP2: ${trade.tp2}`, 220, 315);
  ctx.fillText(`SL: ${trade.sl}`, 395, 315);

  ctx.fillText(`OI: ${trade.oi}`, 45, 375);
  ctx.fillText(`Volume: ${trade.volume}`, 350, 375);

  ctx.fillStyle = '#7c3aed';
  ctx.font = 'bold 30px Arial';
  ctx.fillText(`Score: ${trade.score}/100`, 45, 440);

  ctx.fillStyle = '#6b7280';
  ctx.font = '22px Arial';
  ctx.fillText('ST Flow Signals • ليست توصية مالية', 45, 485);

  return canvas.toBuffer('image/png');
}

async function sendTrade(trade) {
  if (!TARGET_CHAT_ID) return;

  const image = createTradeCard(trade);

  const caption =
`🚨 صفقة محتملة عالية الجودة

السهم: ${trade.symbol}
الاتجاه: ${trade.side}
العقد: ${trade.strike} ${trade.side}
الانتهاء: ${trade.expiration}

💰 الدخول: ${trade.entry}
🎯 TP1: ${trade.tp1}
🎯 TP2: ${trade.tp2}
🛑 SL: ${trade.sl}

⭐ درجة الصفقة: ${trade.score}/100

⚠️ ليست توصية مالية`;

  await bot.sendPhoto(TARGET_CHAT_ID, image, { caption });
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
    bid: '1.42',
    ask: '1.50',
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
`🚨 ST Flow Signals يعمل الآن

البوت سيرسل صفقات تلقائية عند تحقق الشروط.

للتجربة اكتب:
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

console.log('ST Flow Signals bot is running...');
