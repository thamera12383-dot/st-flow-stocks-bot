require('dotenv').config();

const TelegramBot = require('node-telegram-bot-api');

const bot = new TelegramBot(process.env.BOT_TOKEN, {
  polling: true
});

bot.on('message', async (msg) => {

  if (!msg.text) return;

  await bot.sendMessage(
    msg.chat.id,
    `وصلني: ${msg.text}`
  );

});

bot.sendMessage(
  process.env.ADMIN_CHAT_ID,
  '✅ البوت اشتغل بنجاح'
);
