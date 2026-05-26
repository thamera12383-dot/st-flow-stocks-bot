const TelegramBot = require('node-telegram-bot-api');
const WebSocket = require('ws');
const { createClient } = require('@supabase/supabase-js');

const {
  institutionalScore,
  institutionalText
} = require('./institutional-engine');
const bot = new TelegramBot(process.env.BOT_TOKEN, {
  polling: true
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
function nowIso() {
  return new Date().toISOString();
}

function addDaysIso(days) {
  const d = new Date();
  d.setDate(d.getDate() + Number(days));
  return d.toISOString();
}

function formatDate(v) {
  if (!v) return 'غير متوفر';

  return new Date(v).toLocaleString('ar-SA', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function isAdmin(chatId) {
  return ADMIN_IDS.includes(String(chatId));
}

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = 'ST-';

  for (let i = 0; i < 4; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }

  code += '-';

  for (let i = 0; i < 4; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }

  return code;
}

async function createActivationCode(days = 30) {
  const code = generateCode();
  const expiresAt = addDaysIso(days);

  const { error } = await supabase
    .from('activation_codes')
    .insert({
      code,
      used: false,
      expires_at: expiresAt
    });

  if (error) throw error;

  return { code, days, expiresAt };
}

async function redeemCode(chatId, code) {
  const cleanCode = String(code || '').trim().toUpperCase();

  const { data: activation, error } = await supabase
    .from('activation_codes')
    .select('*')
    .eq('code', cleanCode)
    .single();

  if (error || !activation) {
    return '❌ كود التفعيل غير صحيح.';
  }

  if (activation.used) {
    return '⚠️ هذا الكود مستخدم مسبقًا.';
  }

  if (!activation.expires_at || new Date(activation.expires_at).getTime() < Date.now()) {
    return '⚠️ هذا الكود منتهي الصلاحية.';
  }

  await supabase
    .from('activation_codes')
    .update({
      used: true,
      telegram_id: String(chatId),
      activated_at: nowIso()
    })
    .eq('code', cleanCode);

  await supabase
    .from('users_access')
    .upsert(
      {
        telegram_id: String(chatId),
        code_used: cleanCode,
        expires_at: activation.expires_at,
        active: true,
        notified_3_days: false
      },
      { onConflict: 'telegram_id' }
    );

  return `✅ تم تفعيل اشتراكك بنجاح.

📅 ينتهي الاشتراك:
${formatDate(activation.expires_at)}`;
}

bot.onText(/\/start/, async (msg) => {
  await bot.sendMessage(
    msg.chat.id,
`🚀 مرحبًا بك في بوت سيولة الشركات

البوت يعمل الآن بمحرك Live Flow مباشر.

لتفعيل اشتراكك:
/redeem CODE`
  );
});

bot.onText(/\/myid/, async (msg) => {
  await bot.sendMessage(
    msg.chat.id,
    `🆔 ID:\n${msg.chat.id}`
  );
});

bot.onText(/\/gencode(?:\s+(\d+))?/, async (msg, match) => {
  if (!isAdmin(msg.chat.id)) {
    return bot.sendMessage(msg.chat.id, '⛔ للأدمن فقط');
  }

  const days = Number(match[1] || 30);
  const result = await createActivationCode(days);

  await bot.sendMessage(
    msg.chat.id,
`✅ كود جديد:

${result.code}

⏳ المدة:
${days} يوم

📅 الصلاحية:
${formatDate(result.expiresAt)}`
  );
});

bot.onText(/\/redeem (.+)/, async (msg, match) => {
  try {
    const result = await redeemCode(msg.chat.id, match[1]);
    await bot.sendMessage(msg.chat.id, result);
  } catch (err) {
    await bot.sendMessage(
      msg.chat.id,
      `⚠️ حدث خطأ:\n${err.message}`
    );
  }
});

bot.onText(/\/status/, async (msg) => {
  const { data: user } = await supabase
    .from('users_access')
    .select('*')
    .eq('telegram_id', String(msg.chat.id))
    .single();

  if (!user) {
    return bot.sendMessage(msg.chat.id, '🔒 لا يوجد اشتراك فعال');
  }

  const active =
    user.active &&
    user.expires_at &&
    new Date(user.expires_at).getTime() > Date.now();

  await bot.sendMessage(
    msg.chat.id,
`${active ? '✅ اشتراكك فعال' : '❌ اشتراكك منتهي'}

📅 ينتهي:
${formatDate(user.expires_at)}`
  );
});

async function getLatestFlows(symbol) {

  try {

    const { data, error } = await supabase
      .from('live_flows')
      .select('*')
      .eq('symbol', symbol)
      .order('created_at', { ascending: false })
      .limit(5);

    if (error) throw error;

    return data || [];

  } catch (err) {

    console.error(err.message);
    return [];

  }
}

function buildSymbolMessage(symbol, flows) {

  if (!flows.length) {

    return `⚠️ لا توجد تدفقات حديثة على ${symbol}`;

  }

  const top = flows[0];

  const score =
    institutionalScore(top);

  const classification =
    institutionalText(score);

  const lines = flows.map((flow, i) => {

    return `
${i + 1}) ${flow.side}

💰 Premium:
$${fmt(flow.premium)}

📦 الحجم:
${fmt(flow.size)}

⚡ التنفيذ:
${flow.execution_type}

🧹 Sweep:
${flow.is_sweep ? '✅' : '❌'}
`;

  }).join('\n━━━━━━━━━━━━━━\n');

  return `🚨 ${symbol} Live Flow

🏦 التصنيف:
${classification}

━━━━━━━━━━━━━━

${lines}

━━━━━━━━━━━━━━

🧠 القراءة:

${classification.includes('مؤسسي')
  ? 'يوجد دخول سيولة ذكية واضحة على السهم.'
  : 'التدفقات الحالية ليست مؤسسية بشكل واضح.'}

⏱ تحديث مباشر`;
}

bot.on('message', async (msg) => {

  try {

    const text = String(msg.text || '')
      .trim()
      .toUpperCase();

    if (!text) return;

    if (text.startsWith('/')) return;

    if (!/^[A-Z]{1,5}$/.test(text)) {

      return bot.sendMessage(
        msg.chat.id,
`⚠️ الرمز غير صحيح

أمثلة:
TSLA
NVDA
SPY`
      );

    }

    const symbol = text;

    const { data: user } = await supabase
      .from('users_access')
      .select('*')
      .eq('telegram_id', String(msg.chat.id))
      .single();

    if (
      !user ||
      !user.active ||
      !user.expires_at ||
      new Date(user.expires_at).getTime() < Date.now()
    ) {

      return bot.sendMessage(
        msg.chat.id,
`🔒 الاشتراك غير مفعل

للتفعيل:
/redeem CODE`
      );

    }

    await bot.sendMessage(
      msg.chat.id,
      `⏳ جاري فحص ${symbol}...`
    );

    const flows =
      await getLatestFlows(symbol);

    const message =
      buildSymbolMessage(symbol, flows);

    await bot.sendMessage(
      msg.chat.id,
      message
    );

  } catch (err) {

    console.error(err);

    await bot.sendMessage(
      msg.chat.id,
      `⚠️ حدث خطأ\n${err.message}`
    );

  }

});

process.on('SIGTERM', async () => {

  console.log('🛑 إيقاف البوت قبل إعادة التشغيل');

  try {
    await bot.stopPolling();
  } catch (err) {}

  try {
    if (ws) ws.close();
  } catch (err) {}

  process.exit(0);

});

process.on('SIGINT', async () => {

  console.log('🛑 إيقاف يدوي للبوت');

  try {
    await bot.stopPolling();
  } catch (err) {}

  try {
    if (ws) ws.close();
  } catch (err) {}

  process.exit(0);

});
