const TelegramBot = require('node-telegram-bot-api');

const token = process.env.BOT_TOKEN;

const bot = new TelegramBot(token, { polling: true });

bot.onText(/\/start/, (msg) => {
    bot.sendMessage(msg.chat.id, '🚀 تم تشغيل بوت ST Flow Stocks');
});

bot.onText(/\/stocks/, (msg) => {
    bot.sendMessage(msg.chat.id, `
📊 قائمة الشركات:

/tsla - Tesla
/nvda - Nvidia
/aapl - Apple
/amd - AMD
`);
});

bot.onText(/\/tsla/, (msg) => {
    bot.sendMessage(msg.chat.id, '📈 تحديث Tesla');
});

bot.onText(/\/nvda/, (msg) => {
    bot.sendMessage(msg.chat.id, '📈 تحديث Nvidia');
});

bot.onText(/\/aapl/, (msg) => {
    bot.sendMessage(msg.chat.id, '📈 تحديث Apple');
});

bot.onText(/\/amd/, (msg) => {
    bot.sendMessage(msg.chat.id, '📈 تحديث AMD');
});

bot.onText(/\/stop/, (msg) => {
    bot.sendMessage(msg.chat.id, '🛑 تم إيقاف التحديث');
});

bot.onText(/\/change/, (msg) => {
    bot.sendMessage(msg.chat.id, '🔄 أرسل اسم الشركة الجديدة');
});

bot.onText(/\/help/, (msg) => {
    bot.sendMessage(msg.chat.id, '❓ استخدم الأوامر من القائمة');
});

console.log('Bot is running...');
