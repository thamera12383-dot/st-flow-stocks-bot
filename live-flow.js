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

// =====================
// إعدادات الفلترة
// =====================

const MIN_PREMIUM = 150000; // أقل قيمة صفقة: 150 ألف دولار
const MIN_SIZE = 100;       // أقل عدد عقود
const MAX_SPREAD_PERCENT = 15;

const ALERT_COOLDOWN_MS = 2 * 60 * 1000;

const sentAlerts = new Map();

// =====================
// Helpers
// =====================

function fmt(n) {
  return Number(n || 0).toLocaleString('en-US');
}

function optionTypeFromSymbol(sym) {
  const s = String(sym || '');

  if (s.includes('C')) return 'كول / CALL';
  if (s.includes('P')) return 'بوت / PUT';

  return 'غير معروف';
}

function canAlert(key) {
  const last = sentAlerts.get(key) || 0;

  if (Date.now() - last < ALERT_COOLDOWN_MS) {
    return false;
  }

  sentAlerts.set(key, Date.now());

  return true;
}

function buildAlert(msg, premium, sideType, spreadPercent) {
  const optionType = optionTypeFromSymbol(msg.sym);

  let strength = 'متوسطة';

  if (premium >= 1000000) {
    strength = 'مؤسسية قوية جدًا';
  } else if (premium >= 500000) {
    strength = 'قوية جدًا';
  } else if (premium >= 250000) {
    strength = 'قوية';
  }

  return `🚨 سيولة ذكية مباشرة

📌 العقد:
${msg.sym}

📈 النوع:
${optionType}

💰 سعر التنفيذ:
$${Number(msg.p || 0).toFixed(2)}

📦 حجم العقود:
${fmt(msg.s)}

💵 قيمة الصفقة:
$${fmt(premium)}

━━━━━━━━━━━━━━

⚡ نوع التنفيذ:
${sideType}

📊 السبريد:
${spreadPercent.toFixed(2)}%

🔥 القوة:
${strength}

🕒 الوقت:
${new Date(msg.t).toLocaleString('ar-SA')}

━━━━━━━━━━━━━━

🧠 القراءة الذكية:
تم رصد تدفق مباشر على عقد خيارات بحجم كبير.
يفضل مراقبة حركة السعر والتأكيد قبل الدخول.`;
}

// =====================
// WebSocket Connection
// =====================

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
          console.log(
            msg.message || JSON.stringify(msg)
          );

          const statusMessage =
            String(msg.message || '').toLowerCase();

          if (
            statusMessage.includes('auth') ||
            statusMessage.includes('success')
          ) {
            ws.send(JSON.stringify({
              action: 'subscribe',
              params: 'T.*'
            }));

            console.log(
              '📡 Subscribed To Live Options Trades'
            );
          }

          continue;
        }

        if (msg.ev !== 'T') continue;

        const price = Number(msg.p || 0);
        const size = Number(msg.s || 0);

        const premium =
          price * size * 100;

        if (premium < MIN_PREMIUM) continue;
        if (size < MIN_SIZE) continue;

        const ask = Number(msg.ap || 0);
        const bid = Number(msg.bp || 0);

        let spreadPercent = 0;

        if (ask > 0 && bid > 0) {
          spreadPercent =
            ((ask - bid) / ((ask + bid) / 2)) * 100;

          if (spreadPercent > MAX_SPREAD_PERCENT) {
            continue;
          }
        }

        let sideType = '🟡 داخل السبريد / غير واضح';

        if (ask > 0 && price >= ask) {
          sideType = '🟢 شراء هجومي على الـ Ask';
        } else if (bid > 0 && price <= bid) {
          sideType = '🔴 بيع هجومي على الـ Bid';
        }

        const key =
          `${msg.sym}_${Math.floor(Date.now() / ALERT_COOLDOWN_MS)}`;

        if (!canAlert(key)) continue;

        const alert =
          buildAlert(
            msg,
            premium,
            sideType,
            spreadPercent
          );

        for (const adminId of ADMIN_IDS) {
          try {
            await bot.sendMessage(
              adminId,
              alert
            );
          } catch (err) {
            console.error(
              'Telegram Send Error:',
              err.message
            );
          }
        }

        console.log(
          `🚨 Alert Sent: ${msg.sym} $${fmt(premium)}`
        );
      }
    } catch (err) {
      console.error(
        'Message Error:',
        err.message
      );
    }
  });

  ws.on('error', (err) => {
    console.error(
      '❌ WS Error:',
      err.message
    );
  });

  ws.on('close', () => {
    console.log(
      '🔌 Connection Closed — Reconnecting in 5s'
    );

    setTimeout(() => {
      connect();
    }, 5000);
  });
}

connect();

console.log(
  '🚀 Live Options Tape Engine Started'
);
