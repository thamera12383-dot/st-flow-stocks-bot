const TelegramBot = require('node-telegram-bot-api');
const { createClient } = require('@supabase/supabase-js');

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });

const API_KEY = process.env.MASSIVE_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const ADMIN_IDS = String(process.env.ADMIN_IDS || '')
  .split(',')
  .map(x => x.trim())
  .filter(Boolean);

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

const userCooldown = new Map();
const CACHE = new Map();
const activeUpdates = new Map();
const sentFlowAlerts = new Map();

const watchlist = new Set(
  String(process.env.FLOW_WATCHLIST || '')
    .split(',')
    .map(x => x.trim().toUpperCase())
    .filter(Boolean)
);

const USER_COOLDOWN_SECONDS = 10;
const CACHE_SECONDS = 60;
const UPDATE_INTERVAL_MS = 60 * 1000;
const UPDATE_DURATION_MS = 5 * 60 * 1000;

const SCANNER_INTERVAL_MS = 60 * 1000;
const FLOW_ALERT_COOLDOWN_MS = 30 * 60 * 1000;

const MIN_ALERT_VOLUME = 3000;
const MIN_ALERT_VOLUME_OI_RATIO = 3;
const MIN_ALERT_GAMMA = 0.04;
const MAX_ALERT_DISTANCE_PERCENT = 2;
const MIN_ALERT_DELTA = 0.20;
const MAX_ALERT_DELTA = 0.55;
const MAX_ALERT_SPREAD_PERCENT = 20;

const EXPIRY_WARNING_DAYS = 3;
const CHECK_EXPIRY_INTERVAL = 12 * 60 * 60 * 1000;

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

async function getUserAccess(chatId) {
  const { data, error } = await supabase
    .from('users_access')
    .select('*')
    .eq('telegram_id', String(chatId))
    .single();

  if (error && error.code !== 'PGRST116') throw error;

  return data || null;
}

async function hasActiveAccess(chatId) {
  const user = await getUserAccess(chatId);

  if (!user) return false;
  if (!user.active) return false;
  if (!user.expires_at) return false;

  return new Date(user.expires_at).getTime() > Date.now();
}

async function requireAccess(chatId) {
  const access = await hasActiveAccess(chatId);

  if (access) return true;

  await bot.sendMessage(
    chatId,
`🔒 البوت مخصص للمشتركين فقط.

لتفعيل اشتراكك:

/redeem CODE

مثال:
/redeem ST-ABCD-1234`
  );

  return false;
}
async function redeemCode(chatId, code) {
  const cleanCode = String(code || '').trim().toUpperCase();

  const { data: activation, error } = await supabase
    .from('activation_codes')
    .select('*')
    .eq('code', cleanCode)
    .single();

  if (error || !activation) {
    return {
      ok: false,
      message: '❌ كود التفعيل غير صحيح.'
    };
  }

  if (activation.used) {
    return {
      ok: false,
      message: '⚠️ هذا الكود مستخدم مسبقًا.'
    };
  }

  const expiresAt = activation.expires_at;

  if (!expiresAt || new Date(expiresAt).getTime() < Date.now()) {
    return {
      ok: false,
      message: '⚠️ هذا الكود منتهي الصلاحية.'
    };
  }

  const { error: updateError } = await supabase
    .from('activation_codes')
    .update({
      used: true,
      telegram_id: String(chatId),
      activated_at: nowIso()
    })
    .eq('code', cleanCode)
    .eq('used', false);

  if (updateError) throw updateError;

  const { error: userError } = await supabase
    .from('users_access')
    .upsert(
      {
        telegram_id: String(chatId),
        code_used: cleanCode,
        expires_at: expiresAt,
        active: true,
        notified_3_days: false
      },
      { onConflict: 'telegram_id' }
    );

  if (userError) throw userError;

  return {
    ok: true,
    message:
`✅ تم تفعيل اشتراكك بنجاح.

📅 ينتهي الاشتراك:
${formatDate(expiresAt)}

🚀 يمكنك الآن استخدام البوت.`
  };
}

function fmt(n) {
  if (n === undefined || n === null || isNaN(Number(n))) {
    return 'غير متوفر';
  }

  return Number(n).toLocaleString('en-US');
}

function fmtPrice(n) {
  if (n === undefined || n === null || isNaN(Number(n))) {
    return 'غير متوفر';
  }

  return Number(n).toFixed(2);
}

function fmtPercent(n) {
  if (n === undefined || n === null || isNaN(Number(n))) {
    return 'غير متوفر';
  }

  return `${Number(n).toFixed(2)}%`;
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function canRequest(chatId) {
  const last = userCooldown.get(chatId) || 0;
  const diff = nowSeconds() - last;

  if (diff < USER_COOLDOWN_SECONDS) {
    return {
      ok: false,
      wait: USER_COOLDOWN_SECONDS - diff
    };
  }

  userCooldown.set(chatId, nowSeconds());

  return { ok: true };
}

function getContractType(item) {
  return String(
    item?.details?.contract_type || ''
  ).toUpperCase();
}

function getStrike(item) {
  return item?.details?.strike_price || 'غير متوفر';
}

function getVolume(item) {
  return Number(item?.day?.volume || 0);
}

function getOI(item) {
  return Number(item?.open_interest || 0);
}

function getExpiration(item) {
  return item?.details?.expiration_date || 'غير متوفر';
}

function getIV(item) {
  return item?.implied_volatility;
}

function getDelta(item) {
  return item?.greeks?.delta;
}

function getGamma(item) {
  return item?.greeks?.gamma;
}

function getTheta(item) {
  return item?.greeks?.theta;
}

function getBid(item) {
  return Number(item?.last_quote?.bid || 0);
}

function getAsk(item) {
  return Number(item?.last_quote?.ask || 0);
}

function getMidPrice(item) {
  const bid = getBid(item);
  const ask = getAsk(item);

  if (bid > 0 && ask > 0) {
    return (bid + ask) / 2;
  }

  return Number(
    item?.day?.close ||
    item?.last_trade?.price ||
    0
  );
}
function gammaText(gamma) {
  const g = Number(gamma);

  if (gamma === undefined || gamma === null || isNaN(g)) {
    return 'غير متوفر';
  }

  if (g >= 0.08) return 'مرتفع جدًا';
  if (g >= 0.04) return 'مرتفع';
  if (g >= 0.02) return 'متوسط';

  return 'منخفض';
}

function distancePercent(strike, stockPrice) {
  const s = Number(strike);
  const p = Number(stockPrice);

  if (!s || !p || isNaN(s) || isNaN(p)) {
    return null;
  }

  return Math.abs(((s - p) / p) * 100);
}

function daysToExpiration(dateStr) {
  if (!dateStr) return 999;

  const now = new Date();
  const exp = new Date(dateStr);

  return Math.ceil(
    (exp - now) / (1000 * 60 * 60 * 24)
  );
}

async function apiGet(url) {
  if (!API_KEY) {
    throw new Error('Missing MASSIVE_API_KEY');
  }

  const res = await fetch(url);
  const data = await res.json();

  if (!res.ok) {
    throw new Error(
      data?.error ||
      data?.message ||
      'API Error'
    );
  }

  return data;
}

async function getStockSnapshot(symbol) {
  const url =
    `https://api.massive.com/v2/aggs/ticker/${symbol}/prev?adjusted=true&apiKey=${API_KEY}`;

  const data = await apiGet(url);

  const r = data?.results?.[0];

  if (!r) return null;

  const change =
    r.o
      ? ((r.c - r.o) / r.o) * 100
      : null;

  return {
    price: r.c,
    open: r.o,
    high: r.h,
    low: r.l,
    volume: r.v,
    change
  };
}

async function getOptionsChain(symbol) {
  const url =
    `https://api.massive.com/v3/snapshot/options/${symbol}?limit=250&apiKey=${API_KEY}`;

  const data = await apiGet(url);

  return data.results || [];
}

function qualityScore(item, stockPrice) {
  const volume = getVolume(item);
  const oi = getOI(item);

  const gamma = Number(
    getGamma(item) || 0
  );

  const delta = Math.abs(
    Number(getDelta(item) || 0)
  );

  const iv = Number(
    getIV(item) || 0
  );

  const distance = distancePercent(
    getStrike(item),
    stockPrice
  );

  const dte = daysToExpiration(
    getExpiration(item)
  );

  const bid = getBid(item);
  const ask = getAsk(item);
  const mid = getMidPrice(item);

  let score = 0;

  score += volume * 1.2;
  score += oi * 0.35;

  if (volume > oi) {
    score += 6000;
  } else if (volume > oi * 0.7) {
    score += 3000;
  }

  if (distance !== null) {
    if (distance <= 0.5) {
      score += 6000;
    } else if (distance <= 1) {
      score += 4500;
    } else if (distance <= 2) {
      score += 2500;
    } else if (distance <= 3) {
      score += 1000;
    }
  }

  if (gamma >= 0.08) {
    score += 5000;
  } else if (gamma >= 0.04) {
    score += 3000;
  } else if (gamma >= 0.02) {
    score += 1200;
  }

  if (delta >= 0.25 && delta <= 0.45) {
    score += 3000;
  } else if (delta > 0.45 && delta <= 0.65) {
    score += 1200;
  }

  if (dte >= 0 && dte <= 7) {
    score += 2000;
  } else if (dte <= 14) {
    score += 800;
  }

  if (mid >= 1.5 && mid <= 2.5) {
    score += 3000;
  }

  if (bid > 0 && ask > 0 && mid > 0) {
    const spreadPercent =
      ((ask - bid) / mid) * 100;

    if (spreadPercent <= 8) {
      score += 1500;
    } else if (spreadPercent <= 15) {
      score += 700;
    } else {
      score -= 1000;
    }
  }

  if (iv >= 0.9) {
    score -= 2500;
  } else if (iv >= 0.6) {
    score -= 1000;
  }

  return Math.round(score);
}

function isStrongFlowCandidate(item, stockPrice) {
  const volume = getVolume(item);
  const oi = getOI(item);

  const gamma = Number(
    getGamma(item) || 0
  );

  const delta = Math.abs(
    Number(getDelta(item) || 0)
  );

  const strike = getStrike(item);

  const distance = distancePercent(
    strike,
    stockPrice
  );

  const bid = getBid(item);
  const ask = getAsk(item);
  const mid = getMidPrice(item);

  if (!volume || !oi) return false;

  if (volume < MIN_ALERT_VOLUME) {
    return false;
  }

  if (
    volume < oi * MIN_ALERT_VOLUME_OI_RATIO
  ) {
    return false;
  }

  if (gamma < MIN_ALERT_GAMMA) {
    return false;
  }

  if (
    distance === null ||
    distance > MAX_ALERT_DISTANCE_PERCENT
  ) {
    return false;
  }

  if (
    delta < MIN_ALERT_DELTA ||
    delta > MAX_ALERT_DELTA
  ) {
    return false;
  }

  if (mid <= 0) {
    return false;
  }

  if (bid > 0 && ask > 0) {
    const spreadPercent =
      ((ask - bid) / mid) * 100;

    if (
      spreadPercent >
      MAX_ALERT_SPREAD_PERCENT
    ) {
      return false;
    }
  }

  return true;
}
function buildQuickFlowAlert(symbol, item, stockPrice) {
  const side = getContractType(item);
  const strike = getStrike(item);

  const volume = getVolume(item);
  const oi = getOI(item);

  const gamma = Number(
    getGamma(item) || 0
  );

  const delta = Number(
    getDelta(item) || 0
  );

  const expiry = getExpiration(item);

  const mid = getMidPrice(item);

  const ratio =
    oi > 0
      ? (volume / oi).toFixed(1)
      : '0';

  return `🚨 تدفق سيولة قوي

📊 السهم:
${symbol}

📈 النوع:
${side}

🎯 السترايك:
${strike}

📅 الانتهاء:
${expiry}

━━━━━━━━━━━━━━

📦 الحجم:
${fmt(volume)}

📂 العقود المفتوحة:
${fmt(oi)}

🔥 نسبة Volume/OI:
${ratio}x

⚡ Gamma:
${gammaText(gamma)}

Δ Delta:
${delta ? delta.toFixed(2) : 'غير متوفر'}

💵 سعر العقد:
${mid > 0 ? '$' + mid.toFixed(2) : 'غير متوفر'}

━━━━━━━━━━━━━━

🧠 القراءة:
دخول سيولة غير معتاد على عقد قريب من السعر.`;
}

function flowAlertKey(symbol, item) {
  return [
    symbol,
    getContractType(item),
    getStrike(item),
    getExpiration(item)
  ].join('_');
}

function canSendFlowAlert(symbol, item) {
  const key = flowAlertKey(symbol, item);

  const last =
    sentFlowAlerts.get(key) || 0;

  const diff =
    Date.now() - last;

  if (diff < FLOW_ALERT_COOLDOWN_MS) {
    return false;
  }

  sentFlowAlerts.set(
    key,
    Date.now()
  );

  return true;
}

async function scanMarketFlows() {
  try {
    const symbols = [...watchlist];

    for (const symbol of symbols) {
      try {
        const stock =
          await getStockSnapshot(symbol);

        if (!stock?.price) continue;

        const chain =
          await getOptionsChain(symbol);

        if (!chain?.length) continue;

        const strongContracts =
          chain
            .filter(item =>
              isStrongFlowCandidate(
                item,
                stock.price
              )
            )
            .map(item => ({
              item,
              score: qualityScore(
                item,
                stock.price
              )
            }))
            .sort(
              (a, b) =>
                b.score - a.score
            )
            .slice(0, 1);

        if (!strongContracts.length) {
          continue;
        }

        const best =
          strongContracts[0].item;

        const canSend =
          canSendFlowAlert(
            symbol,
            best
          );

        if (!canSend) {
          continue;
        }

        const alert =
          buildQuickFlowAlert(
            symbol,
            best,
            stock.price
          );

        for (const adminId of ADMIN_IDS) {
          try {
            await bot.sendMessage(
              adminId,
              alert
            );
          } catch (err) {
            console.error(
              'Alert Send Error:',
              err.message
            );
          }
        }
      } catch (err) {
        console.error(
          `Scanner Error ${symbol}:`,
          err.message
        );
      }
    }
  } catch (err) {
    console.error(
      'scanMarketFlows Error:',
      err.message
    );
  }
}

setInterval(() => {
  scanMarketFlows();
}, SCANNER_INTERVAL_MS);

bot.onText(
  /\/addwatch\s+([A-Za-z]{1,10})/,
  async (msg, match) => {

    if (!isAdmin(msg.chat.id)) {
      return bot.sendMessage(
        msg.chat.id,
        '⛔ هذا الأمر للمالك فقط.'
      );
    }

    const symbol =
      match[1].toUpperCase();

    watchlist.add(symbol);

    await bot.sendMessage(
      msg.chat.id,
      `✅ تم إضافة ${symbol} لقائمة الفحص التلقائي.`
    );
  }
);

bot.onText(
  /\/removewatch\s+([A-Za-z]{1,10})/,
  async (msg, match) => {

    if (!isAdmin(msg.chat.id)) {
      return bot.sendMessage(
        msg.chat.id,
        '⛔ هذا الأمر للمالك فقط.'
      );
    }

    const symbol =
      match[1].toUpperCase();

    watchlist.delete(symbol);

    await bot.sendMessage(
      msg.chat.id,
      `🗑 تم حذف ${symbol} من قائمة الفحص التلقائي.`
    );
  }
);

bot.onText(
  /\/watchlist/,
  async (msg) => {

    if (!isAdmin(msg.chat.id)) {
      return bot.sendMessage(
        msg.chat.id,
        '⛔ هذا الأمر للمالك فقط.'
      );
    }

    const list = [...watchlist];

    await bot.sendMessage(
      msg.chat.id,
      list.length
        ? `📋 قائمة الفحص التلقائي:\n\n${list.join('\n')}`
        : '⚠️ قائمة الفحص التلقائي فارغة.'
    );
  }
);

console.log(
  '🚀 Smart Liquidity Scanner Running...'
);
function topContracts(chain, type, stockPrice, count = 3) {
  return chain
    .filter(x => {
      if (getContractType(x) !== type) return false;

      const strike = Number(getStrike(x));
      const dist = distancePercent(strike, stockPrice);

      if (isNaN(strike) || dist === null) return false;

      return dist <= 3;
    })
    .map(item => ({
      item,
      qScore: qualityScore(item, stockPrice)
    }))
    .sort((a, b) => b.qScore - a.qScore)
    .slice(0, count)
    .map(x => x.item);
}

function topGammaContracts(chain, stockPrice, count = 3) {
  return chain
    .filter(x => {
      const gamma = Number(getGamma(x) || 0);
      const strike = Number(getStrike(x));
      const dist = distancePercent(strike, stockPrice);
      const volume = getVolume(x);

      return gamma > 0 && volume > 0 && dist !== null && dist <= 3;
    })
    .sort((a, b) => Number(getGamma(b) || 0) - Number(getGamma(a) || 0))
    .slice(0, count);
}

function nearestSupportResistance(stock) {
  if (!stock) {
    return {
      support: 'غير متوفر',
      resistance: 'غير متوفر'
    };
  }

  return {
    support: stock.low,
    resistance: stock.high
  };
}

function momentumText(stock) {
  if (!stock || stock.change === null || stock.change === undefined) {
    return 'غير متوفر';
  }

  if (stock.change > 1) return '🔥 صاعد قوي';
  if (stock.change > 0) return '🟢 صاعد';
  if (stock.change < -1) return '🔴 هابط قوي';
  if (stock.change < 0) return '🔴 هابط';

  return '⚪ محايد';
}

function momentumSide(stock) {
  if (!stock || stock.change === null || stock.change === undefined) {
    return 'NEUTRAL';
  }

  if (stock.change > 0) return 'CALL';
  if (stock.change < 0) return 'PUT';

  return 'NEUTRAL';
}

function getStrongestContract(calls, puts, stockPrice) {
  const all = [
    ...calls.map(x => ({
      item: x,
      side: 'CALL',
      qScore: qualityScore(x, stockPrice)
    })),
    ...puts.map(x => ({
      item: x,
      side: 'PUT',
      qScore: qualityScore(x, stockPrice)
    }))
  ];

  if (!all.length) return null;

  all.sort((a, b) => b.qScore - a.qScore);

  return all[0];
}

function biasText(calls, puts, stockPrice, stock) {
  const calcSide = list =>
    list.reduce((sum, item) => sum + qualityScore(item, stockPrice), 0);

  const totalCall = calcSide(calls);
  const totalPut = calcSide(puts);
  const mSide = momentumSide(stock);

  if (totalCall > totalPut * 1.25) {
    if (mSide === 'PUT') return '🟡 تدفق كول عكسي يحتاج تأكيد';
    return '🟢 تدفق شرائي قوي';
  }

  if (totalPut > totalCall * 1.25) {
    if (mSide === 'CALL') return '🟡 تدفق بوت عكسي يحتاج تأكيد';
    return '🔴 تدفق بيعي قوي';
  }

  return '⚪ تدفق متوازن';
}

function gammaDominantSide(gammaLeaders) {
  if (!gammaLeaders.length) return 'NEUTRAL';

  let callScore = 0;
  let putScore = 0;

  for (const item of gammaLeaders) {
    const g = Number(getGamma(item) || 0);
    const type = getContractType(item);

    if (type === 'CALL') callScore += g;
    if (type === 'PUT') putScore += g;
  }

  if (callScore > putScore * 1.2) return 'CALL';
  if (putScore > callScore * 1.2) return 'PUT';

  return 'NEUTRAL';
}
async function buildFlowMessage(symbol) {
  const cached = CACHE.get(symbol);

  if (cached && nowSeconds() - cached.time < CACHE_SECONDS) {
    return cached.message;
  }

  const stock = await getStockSnapshot(symbol);

  if (!stock) {
    return `⚠️ تعذر جلب بيانات ${symbol}`;
  }

  const chain = await getOptionsChain(symbol);

  const calls = topContracts(chain, 'CALL', stock.price, 3);
  const puts = topContracts(chain, 'PUT', stock.price, 3);
  const gammaLeaders = topGammaContracts(chain, stock.price, 3);

  const sr = nearestSupportResistance(stock);
  const momentum = momentumText(stock);
  const strongest = getStrongestContract(calls, puts, stock.price);
  const bias = biasText(calls, puts, stock.price, stock);
  const gSide = gammaDominantSide(gammaLeaders);

  if (!strongest) {
    const msg =
`⚠️ لا توجد عقود قوية حالياً على ${symbol}

💰 السعر:
${fmtPrice(stock.price)}

يرجى المحاولة لاحقاً.`;

    CACHE.set(symbol, {
      time: nowSeconds(),
      message: msg
    });

    return msg;
  }

  const item = strongest.item;
  const side = strongest.side;
  const strike = getStrike(item);
  const expiry = getExpiration(item);
  const volume = getVolume(item);
  const oi = getOI(item);
  const delta = getDelta(item);
  const gamma = getGamma(item);
  const iv = getIV(item);
  const theta = getTheta(item);
  const qScore = strongest.qScore;
  const dist = distancePercent(strike, stock.price);
  const midPrice = getMidPrice(item);

  let quality = 'متوسطة';

  if (qScore >= 65000) {
    quality = 'قوية جدًا';
  } else if (qScore >= 40000) {
    quality = 'قوية';
  } else if (qScore >= 22000) {
    quality = 'جيدة';
  }

  const gammaSection =
    gammaLeaders.length
      ? gammaLeaders
          .map((x, i) => {
            return `${i + 1}) ${getContractType(x)} ${getStrike(x)} — Γ ${Number(getGamma(x) || 0).toFixed(2)}`;
          })
          .join('\n')
      : 'لا توجد بيانات Gamma';

  let smartRead = '';

  const mSide = momentumSide(stock);

  if (side !== mSide && mSide !== 'NEUTRAL') {
    smartRead =
`يوجد تدفق على ${side} لكن اتجاه السهم الحالي عكسه.
الأفضل انتظار تأكيد من السعر قبل الاعتماد على هذا التدفق.`;
  } else if (gSide !== 'NEUTRAL' && gSide !== side) {
    smartRead =
`العقد الأقوى ${side}، لكن أعلى Gamma حالياً على ${gSide}.
هذا يعني وجود ضغط أو منطقة حساسة قرب السعر، ويفضل انتظار كسر أو اختراق واضح.`;
  } else if (volume > oi && Number(gamma || 0) >= 0.04) {
    smartRead =
`دخول سيولة هجومية مع Gamma مرتفعة.
احتمال حركة سريعة إذا استمر الزخم.`;
  } else if (volume > oi) {
    smartRead =
`يوجد دخول سيولة جديدة على العقد الأقوى.
راقب ثبات السعر قرب المستوى الحالي.`;
  } else {
    smartRead =
`التمركز الحالي أقرب إلى احتفاظ وليس دخول هجومي قوي.`;
  }

  const confirmLine =
    side === 'CALL'
      ? `اختراق المقاومة ${fmtPrice(sr.resistance)} يدعم الكول، وكسر الدعم ${fmtPrice(sr.support)} يضعف القراءة.`
      : `كسر الدعم ${fmtPrice(sr.support)} يدعم البوت، واختراق المقاومة ${fmtPrice(sr.resistance)} يضعف القراءة.`;

  const message =
`🚨 ${symbol} — ${bias}

💰 السعر:
${fmtPrice(stock.price)}

📈 التغير:
${stock.change !== null && stock.change !== undefined ? fmtPercent(stock.change) : 'غير متوفر'}

🔥 الاتجاه:
${momentum}

━━━━━━━━━━━━━━

🎯 العقد الأقوى:
${side} ${strike}

📅 الانتهاء:
${expiry}

💵 سعر العقد:
${midPrice > 0 ? '$' + midPrice.toFixed(2) : 'غير متوفر'}

⭐ الجودة:
${quality}

📍 قربه من السعر:
${dist !== null ? dist.toFixed(2) + '%' : 'غير متوفر'}

📦 Volume:
${fmt(volume)}

📂 OI:
${fmt(oi)}

━━━━━━━━━━━━━━

Δ Delta:
${delta !== undefined && delta !== null ? Number(delta).toFixed(2) : 'غير متوفر'}

Γ Gamma:
${gammaText(gamma)}

IV:
${iv !== undefined && iv !== null ? fmtPercent(Number(iv) * 100) : 'غير متوفر'}

Θ Theta:
${theta !== undefined && theta !== null ? Number(theta).toFixed(2) : 'غير متوفر'}

━━━━━━━━━━━━━━

⚡ أعلى Gamma:
${gammaSection}

━━━━━━━━━━━━━━

🧠 القراءة الذكية:
${smartRead}

✅ التأكيد:
${confirmLine}

━━━━━━━━━━━━━━

⚠️ الدعم:
${fmtPrice(sr.support)}

⚠️ المقاومة:
${fmtPrice(sr.resistance)}

⏱ تحديث كل 60 ثانية`;

  CACHE.set(symbol, {
    time: nowSeconds(),
    message
  });

  return message;
}
async function checkExpiringSubscriptions() {
  try {
    const now = new Date();

    const warningDate = new Date(
      now.getTime() +
      EXPIRY_WARNING_DAYS *
      24 *
      60 *
      60 *
      1000
    );

    const { data: users, error } = await supabase
      .from('users_access')
      .select('*')
      .eq('active', true);

    if (error) throw error;

    for (const user of users || []) {
      if (!user.expires_at) continue;

      const expiry = new Date(user.expires_at);
      const alreadyNotified = user.notified_3_days === true;
      const isWithinWarning = expiry <= warningDate && expiry > now;

      if (isWithinWarning && !alreadyNotified) {
        await bot.sendMessage(
          user.telegram_id,
`⚠️ تنبيه اشتراك

اشتراكك سينتهي خلال 3 أيام.

📅 تاريخ الانتهاء:
${formatDate(user.expires_at)}

للتجديد تواصل مع الإدارة.`
        );

        await supabase
          .from('users_access')
          .update({
            notified_3_days: true
          })
          .eq('telegram_id', user.telegram_id);
      }
    }
  } catch (err) {
    console.error(
      'Expiry Check Error:',
      err.message
    );
  }
}

function clearUpdate(chatId) {
  const active = activeUpdates.get(chatId);

  if (active?.intervalId) {
    clearInterval(active.intervalId);
  }

  if (active?.timeoutId) {
    clearTimeout(active.timeoutId);
  }

  activeUpdates.delete(chatId);
}

function startAutoUpdate(chatId, symbol) {
  clearUpdate(chatId);

  const intervalId = setInterval(async () => {
    try {
      const msg = await buildFlowMessage(symbol);

      await bot.sendMessage(
        chatId,
        msg
      );
    } catch (err) {
      console.error(err);

      await bot.sendMessage(
        chatId,
        `⚠️ تعذر تحديث ${symbol}`
      );

      clearUpdate(chatId);
    }
  }, UPDATE_INTERVAL_MS);

  const timeoutId = setTimeout(async () => {
    clearUpdate(chatId);

    await bot.sendMessage(
      chatId,
      `✅ انتهت متابعة ${symbol}`
    );
  }, UPDATE_DURATION_MS);

  activeUpdates.set(chatId, {
    symbol,
    intervalId,
    timeoutId
  });
}

async function sendFlow(chatId, symbol) {
  try {
    const access = await requireAccess(chatId);

    if (!access) return;

    const check = canRequest(chatId);

    if (!check.ok) {
      await bot.sendMessage(
        chatId,
        `⏳ انتظر ${check.wait} ثواني`
      );

      return;
    }

    await bot.sendMessage(
      chatId,
      `⏳ جاري تحليل ${symbol}...`
    );

    const msg = await buildFlowMessage(symbol);

    await bot.sendMessage(
      chatId,
      msg
    );

    startAutoUpdate(chatId, symbol);
  } catch (err) {
    console.error(err);

    await bot.sendMessage(
      chatId,
      `حدث خطأ:\n${err.message}`
    );
  }
}
bot.onText(/\/start/, async (msg) => {
  await bot.sendMessage(
    msg.chat.id,
`🚀 مرحبًا بك في ST Flow Stocks

أرسل رمز أي سهم مثل:

TSLA
AAPL
NVDA
SPY`
  );
});

bot.onText(/\/myid/, async (msg) => {
  await bot.sendMessage(
    msg.chat.id,
    `🆔 ID:\n${msg.chat.id}`
  );
});

bot.onText(/\/redeem (.+)/, async (msg, match) => {
  try {
    const result = await redeemCode(
      msg.chat.id,
      match[1]
    );

    await bot.sendMessage(
      msg.chat.id,
      result.message
    );
  } catch (err) {
    await bot.sendMessage(
      msg.chat.id,
      `حدث خطأ:\n${err.message}`
    );
  }
});

bot.onText(/\/status/, async (msg) => {
  const sub = await getUserAccess(msg.chat.id);

  if (!sub) {
    await bot.sendMessage(
      msg.chat.id,
      `🔒 لا يوجد اشتراك فعال`
    );
    return;
  }

  const active = await hasActiveAccess(msg.chat.id);

  await bot.sendMessage(
    msg.chat.id,
`${active ? '✅ فعال' : '❌ منتهي'}

📅 ينتهي:
${formatDate(sub.expires_at)}`
  );
});

bot.onText(/\/gencode(?:\s+(\d+))?/, async (msg, match) => {
  if (!isAdmin(msg.chat.id)) {
    await bot.sendMessage(
      msg.chat.id,
      '⛔ للأدمن فقط'
    );
    return;
  }

  const days = Number(match[1] || 30);
  const result = await createActivationCode(days);

  await bot.sendMessage(
    msg.chat.id,
`✅ كود جديد:

${result.code}

⏳ المدة:
${days} يوم`
  );
});

bot.onText(/\/stop/, async (msg) => {
  clearUpdate(msg.chat.id);

  await bot.sendMessage(
    msg.chat.id,
    '🛑 تم إيقاف التحديث'
  );
});

bot.on('message', async (msg) => {
  const text = msg.text;

  if (!text) return;
  if (text.startsWith('/')) return;

  const symbol = text.trim().toUpperCase();

  if (!/^[A-Z]{1,5}$/.test(symbol)) {
    await bot.sendMessage(
      msg.chat.id,
`⚠️ الرمز غير صحيح

أمثلة:
TSLA
AAPL
NVDA
SPY`
    );
    return;
  }

  sendFlow(msg.chat.id, symbol);
});

checkExpiringSubscriptions();

setInterval(() => {
  checkExpiringSubscriptions();
}, CHECK_EXPIRY_INTERVAL);

scanMarketFlows();

setInterval(() => {
  scanMarketFlows();
}, SCANNER_INTERVAL_MS);

console.log('ST Flow Stocks bot running...');
