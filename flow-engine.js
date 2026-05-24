const axios = require("axios");

const WATCHLIST = [
  "TSLA",
  "NVDA",
  "AAPL",
  "AMD",
  "META",
  "SPY",
  "QQQ"
];

async function scanFlow(bot, chatId) {

  for (const symbol of WATCHLIST) {

    try {

      // مثال تجريبي مؤقت
      const fakeSignal = Math.random() > 0.7;

      if (fakeSignal) {

        const strike = Math.floor(Math.random() * 100) + 100;
        const premium = (Math.random() * 3 + 1).toFixed(2);

        const message = `
🚨 صفقة جديدة مكتشفة

📈 السهم: ${symbol}

🟢 نوع الصفقة: CALL

🎯 السترايك: ${strike}C

💰 سعر العقد: ${premium}

🔥 فلو قوي + حجم مرتفع
📊 OI مرتفع
⚡ زخم قوي

`;

        await bot.sendMessage(chatId, message);

      }

    } catch (err) {

      console.log(err.message);

    }

  }

}

module.exports = { scanFlow };
