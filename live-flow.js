const TelegramBot = require('node-telegram-bot-api');
const WebSocket = require('ws');

const bot = new TelegramBot(process.env.BOT_TOKEN, {
  polling: true
});

const API_KEY = process.env.MASSIVE_API_KEY;

const ADMIN_IDS = String(process.env.ADMIN_IDS || '')
  .split(',')
  .map(x => x.trim())
  .filter(Boolean);

const MIN_PREMIUM = 100000; // أقل قيمة صفقة: 100 ألف دولار
const ALERT_COOLDOWN_MS = 2 * 60 * 1000;

const sentAlerts = new Map();

function fmt(n) {
  return Number(n || 0).toLocaleString('en-US');
}

function optionTypeFromSymbol(sym) {
  if (String(sym).includes('C')) return 'CALL';
  if (String(sym).includes('P')) return 'PUT';
  return 'غير معروف';
}

function canAlert(key) {
  const last = sentAlerts.get(key) || 0;
  if (Date.now() - last < ALERT_COOLDOWN_MS) return false;
  sentAlerts.set(key, Date.now());
  return true;
}

function buildAlert(msg, premium) {
  const side = optionTypeFromSymbol(msg.sym);

  return `🚨 تدفق خيارات مباشر

📌 العقد:
${msg.sym}

📈 النوع:
${side}

💵 سعر التنفيذ:
${msg.p}

📦 الكمية:
${fmt(msg.s)}

💰 قيمة الصفقة:
$${fmt(premium)}

🕒 الوقت:
${new Date(msg.t).toLocaleString('ar-SA')}

━━━━━━━━━━━━━━

🧠 القراءة:
دخول Live Options Tape مباشر على عقد خيارات.`;
}

function connect() {
  const ws = new WebSocket(
    'wss://socket.massive.com/options'
  );

  ws.on('open', () => {
    console.log('✅ Connected To Massive');

    ws.send(JSON.stringify({
      action: 'auth',
      params: API_KEY
    }));
  });

  ws.on('message', async (data) => {
    try {
      const messages = JSON.parse(data);

      for (const msg of messages) {
        if (msg.ev === 'status') {
          console.log(msg.message || JSON.stringify(msg));

          if (
            String(msg.message || '').toLowerCase().includes('auth')
          ) {
            ws.send(JSON.stringify({
              action: 'subscribe',
              params: 'T.*'
            }));

            console.log('📡 Subscribed To Live Options Trades');
          }

          continue;
        }

        if (msg.ev !== 'T') continue;

        const price = Number(msg.p || 0);
        const size = Number(msg.s || 0);
        const premium = price * size * 100;

        if (premium < MIN_PREMIUM) continue;

        const key = `${msg.sym}_${Math.floor(Date.now() / ALERT_COOLDOWN_MS)}`;

        if (!canAlert(key)) continue;

        const alert = buildAlert(msg, premium);

        for (const adminId of ADMIN_IDS) {
          try {
            await bot.sendMessage(adminId, alert);
          } catch (err) {
            console.error('Telegram Send Error:', err.message);
          }
        }

        console.log(`🚨 Alert Sent: ${msg.sym} $${fmt(premium)}`);
      }
    } catch (err) {
      console.error('Message Error:', err.message);
    }
  });

  ws.on('error', (err) => {
    console.error('❌ WS Error:', err.message);
  });

  ws.on('close', () => {
    console.log('🔌 Connection Closed — Reconnecting in 5s');

    setTimeout(() => {
      connect();
    }, 5000);
  });
}

connect();

console.log('🚀 Live Options Tape Engine Started');
