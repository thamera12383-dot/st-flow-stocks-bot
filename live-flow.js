const TelegramBot = require('node-telegram-bot-api');
const WebSocket = require('ws');
const { createClient } = require('@supabase/supabase-js');

const bot = new TelegramBot(process.env.BOT_TOKEN, {
  polling: false
});

const API_KEY = process.env.MASSIVE_API_KEY;

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const ADMIN_IDS = String(process.env.ADMIN_IDS || '')
  .split(',')
  .map(x => x.trim())
  .filter(Boolean);

const WATCHLIST = [
  'SPY',
  'QQQ',
  'NVDA',
  'TSLA',
  'AAPL',
  'META'
];

const MIN_PREMIUM = 150000;
const MIN_SIZE = 100;
const MAX_SPREAD_PERCENT = 15;
const ALERT_COOLDOWN_MS = 2 * 60 * 1000;

const sentAlerts = new Map();

let ws = null;
let reconnectTimer = null;
let isSubscribed = false;
let reconnectDelay = 10000;

function fmt(n) {
  return Number(n || 0).toLocaleString('en-US');
}

function rootSymbol(sym) {
  const cleaned = String(sym || '').replace('O:', '');
  const match = cleaned.match(/^[A-Z]+/);
  return match ? match[0] : '';
}

function optionTypeFromSymbol(sym) {
  const s = String(sym || '');
  if (s.includes('C')) return 'كول / CALL';
  if (s.includes('P')) return 'بوت / PUT';
  return 'غير معروف';
}

function isWatchlistSymbol(sym) {
  return WATCHLIST.includes(rootSymbol(sym));
}

function canAlert(key) {
  const last = sentAlerts.get(key) || 0;

  if (Date.now() - last < ALERT_COOLDOWN_MS) {
    return false;
  }

  sentAlerts.set(key, Date.now());
  return true;
}

function isSweep(msg) {
  if (!msg.q) return false;

  return String(msg.q)
    .toUpperCase()
    .includes('SWEEP');
}

function executionType(price, ask, bid) {
  if (ask > 0 && price >= ask) {
    return '🟢 شراء هجومي على الـ Ask';
  }

  if (bid > 0 && price <= bid) {
    return '🔴 بيع هجومي على الـ Bid';
  }

  return '🟡 داخل السبريد / غير واضح';
}

function strengthText(premium) {
  if (premium >= 1000000) return 'مؤسسية قوية جدًا';
  if (premium >= 500000) return 'قوية جدًا';
  if (premium >= 250000) return 'قوية';
  return 'متوسطة';
}

function buildAlert(msg, premium, spreadPercent, execType, sweep) {
  return `🚨 سيولة ذكية مباشرة

📊 السهم:
${rootSymbol(msg.sym)}

📌 العقد:
${msg.sym}

📈 النوع:
${optionTypeFromSymbol(msg.sym)}

💰 سعر التنفيذ:
$${Number(msg.p || 0).toFixed(2)}

📦 حجم العقود:
${fmt(msg.s)}

💵 قيمة الصفقة:
$${fmt(premium)}

━━━━━━━━━━━━━━

⚡ نوع التنفيذ:
${execType}

📊 السبريد:
${spreadPercent.toFixed(2)}%

🧹 Sweep:
${sweep ? '✅ نعم' : '❌ لا'}

🔥 القوة:
${strengthText(premium)}

🕒 الوقت:
${new Date(msg.t).toLocaleString('ar-SA')}

━━━━━━━━━━━━━━

🧠 القراءة الذكية:
تم رصد تدفق مباشر قوي على عقد خيارات.
لا تدخل مباشرة بدون تأكيد من حركة السعر.`;
}

async function saveFlow(msg, premium, execType, sweep) {
  try {
    await supabase
      .from('live_flows')
      .insert({
        symbol: rootSymbol(msg.sym),
        contract: msg.sym,
        side: optionTypeFromSymbol(msg.sym),
        price: Number(msg.p || 0),
        size: Number(msg.s || 0),
        premium,
        execution_type: execType,
        is_sweep: sweep,
        raw: msg
      });
  } catch (err) {
    console.error('Supabase Save Error:', err.message);
  }
}

function scheduleReconnect() {
  if (reconnectTimer) return;

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, reconnectDelay);
}

function subscribeTrades() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  if (isSubscribed) return;

  isSubscribed = true;

  ws.send(JSON.stringify({
    action: 'subscribe',
    params: 'T.*'
  }));

  console.log('📡 Subscribed To Live Options Trades');
}

function connect() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    return;
  }

  isSubscribed = false;

  ws = new WebSocket('wss://socket.massive.com/options');

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
          const statusText = String(msg.message || '').toLowerCase();

          console.log(msg.message || JSON.stringify(msg));

          if (
            statusText.includes('authenticated') ||
            statusText.includes('connected successfully')
          ) {
            subscribeTrades();
          }

          if (
            statusText.includes('maximum number of websocket connections')
          ) {
            console.log('⚠️ تم تجاوز حد اتصالات Massive. انتظر عدة دقائق قبل إعادة التشغيل.');
            if (ws) ws.close();
            return;
          }

          continue;
        }

        if (msg.ev !== 'T') continue;
        if (!isWatchlistSymbol(msg.sym)) continue;

        const price = Number(msg.p || 0);
        const size = Number(msg.s || 0);
        const premium = price * size * 100;

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

        const execType = executionType(price, ask, bid);
        const sweep = isSweep(msg);

        const key =
          `${msg.sym}_${Math.floor(Date.now() / ALERT_COOLDOWN_MS)}`;

        if (!canAlert(key)) continue;

        await saveFlow(msg, premium, execType, sweep);

        const alert = buildAlert(
          msg,
          premium,
          spreadPercent,
          execType,
          sweep
        );

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
    console.log('🔌 Connection Closed');

    isSubscribed = false;

    scheduleReconnect();
  });
}

connect();

console.log('🚀 Smart Flow Engine Running');
