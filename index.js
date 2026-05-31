require('dotenv').config();

const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const bot = new TelegramBot(process.env.BOT_TOKEN, {
  polling: {
    interval: 300,
    autoStart: true,
    params: {
      timeout: 10
    }
  }
});

const API_KEY = process.env.MASSIVE_API_KEY;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// =====================
// ENV Settings
// =====================

const WATCHLIST = String(process.env.SIGNAL_SYMBOLS || 'SPY,QQQ,TSLA,NVDA,AAPL,AMD,AVGO,AMZN')
  .split(',')
  .map(x => x.trim().toUpperCase())
  .filter(Boolean);

const EXPIRATION_MODE = process.env.EXPIRATION_MODE || 'ALL';

const AUTO_SCAN_MS = Number(process.env.AUTO_SCAN_MS || 5 * 60 * 1000);
const USER_COOLDOWN_MS = Number(process.env.USER_COOLDOWN_MS || 15 * 1000);
const CACHE_MS = Number(process.env.CACHE_MS || 5 * 60 * 1000);
const ALERT_COOLDOWN_MS = Number(process.env.ALERT_COOLDOWN_MS || 20 * 60 * 1000);

const NEAR_SPOT_RANGE = Number(process.env.NEAR_SPOT_RANGE || 0.15);
const MIN_WALL_STRENGTH_RATIO = Number(process.env.MIN_WALL_STRENGTH_RATIO || 0.20);

const FLOW_ENABLED = String(process.env.FLOW_ENABLED || 'true').toLowerCase() === 'true';
const FLOW_LOOKBACK_MINUTES = Number(process.env.FLOW_LOOKBACK_MINUTES || 15);
const FLOW_MAX_CONTRACTS = Number(process.env.FLOW_MAX_CONTRACTS || 8);
const FLOW_TRADE_LIMIT = Number(process.env.FLOW_TRADE_LIMIT || 500);
const FLOW_QUOTE_LIMIT = Number(process.env.FLOW_QUOTE_LIMIT || 500);

const STOCK_BAR_MINUTES = Number(process.env.STOCK_BAR_MINUTES || 5);
const STOCK_BARS_LOOKBACK_DAYS = Number(process.env.STOCK_BARS_LOOKBACK_DAYS || 5);
const SWING_LEFT_RIGHT = Number(process.env.SWING_LEFT_RIGHT || 2);
const TECH_STOP_BUFFER_PCT = Number(process.env.TECH_STOP_BUFFER_PCT || 0.0015);

const userCooldown = new Map();
const gexCache = new Map();
const lastAlert = new Map();

// ✅ منع تكرار معالجة نفس رسالة تيليجرام
const processedMessages = new Set();

// ✅ منع تشغيل فحصين لنفس السهم بنفس اللحظة
const activeManualScans = new Set();

let autoScanIndex = 0;

// =====================
// Helpers
// =====================

function isAdmin(userId) {
  return String(userId) === String(ADMIN_CHAT_ID);
}

function generateCode() {
  return `ST-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
}

function fmt(n) {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return 'N/A';
  return Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 });
}

function fmtCompact(n) {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return 'N/A';
  const num = Number(n);
  const abs = Math.abs(num);

  if (abs >= 1_000_000_000) return `${(num / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `${(num / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${(num / 1_000).toFixed(2)}K`;

  return fmt(num);
}

function fmtPrice(n) {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return 'N/A';
  return Number(n).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}

function isValidSymbol(text) {
  return /^[A-Z]{1,6}$/.test(text);
}

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function pct(part, total) {
  if (!total) return 0;
  return (part / total) * 100;
}

function distancePercent(spot, strike) {
  if (!spot || !strike) return null;
  return ((strike - spot) / spot) * 100;
}

function fmtPercent(n) {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return 'N/A';
  const sign = n > 0 ? '+' : '';
  return `${sign}${Number(n).toFixed(2)}%`;
}

function getContractTicker(item) {
  return item.details?.ticker || item.ticker || item.symbol || item.contract_ticker || null;
}

function getTradePrice(t) {
  return safeNumber(t.price ?? t.p ?? t.trade_price ?? t.last_price, null);
}

function getTradeSize(t) {
  return safeNumber(t.size ?? t.s ?? t.trade_size ?? t.volume, 0);
}

function getTs(x) {
  return safeNumber(
    x.sip_timestamp ??
    x.participant_timestamp ??
    x.t ??
    x.timestamp ??
    x.trf_timestamp,
    0
  );
}

function getBid(q) {
  return safeNumber(q.bid_price ?? q.bp ?? q.bid ?? q.b, null);
}

function getAsk(q) {
  return safeNumber(q.ask_price ?? q.ap ?? q.ask ?? q.a, null);
}

function getTodayISODateNY() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(new Date());

  const get = type => parts.find(p => p.type === type)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function getISODateDaysAgoNY(daysAgo) {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);

  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(d);

  const get = type => parts.find(p => p.type === type)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}
// =====================
// Subscription
// =====================

async function hasActiveSubscription(userId) {
  if (isAdmin(userId)) return true;

  const { data, error } = await supabase
    .from('subscribers')
    .select('expires_at')
    .eq('user_id', String(userId))
    .single();

  if (error || !data) return false;
  return Number(data.expires_at) > Date.now();
}

async function remainingDays(userId) {
  const { data } = await supabase
    .from('subscribers')
    .select('expires_at')
    .eq('user_id', String(userId))
    .single();

  if (!data) return 0;

  const ms = Number(data.expires_at) - Date.now();
  return Math.max(0, Math.ceil(ms / (1000 * 60 * 60 * 24)));
}

// =====================
// Admin Commands
// =====================

bot.onText(/^\/create\s+(\d+)$/i, async (msg, match) => {
  if (!isAdmin(msg.from.id)) return;

  const days = parseInt(match[1], 10);
  const code = generateCode();

  const { error } = await supabase.from('invite_codes').insert({
    code,
    days,
    used: false
  });

  if (error) {
    console.error('CREATE CODE ERROR:', error.message);
    return bot.sendMessage(msg.chat.id, '❌ فشل إنشاء الكود.');
  }

  await bot.sendMessage(
    msg.chat.id,
    `✅ تم إنشاء كود جديد

🔑 الكود:
${code}

⏳ المدة: ${days} يوم`
  );
});

bot.onText(/^\/codes$/i, async (msg) => {
  if (!isAdmin(msg.from.id)) return;

  const { data, error } = await supabase
    .from('invite_codes')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(30);

  if (error || !data || !data.length) {
    return bot.sendMessage(msg.chat.id, '❌ لا توجد أكواد.');
  }

  let text = '📋 آخر الأكواد:\n\n';

  for (const c of data) {
    text += `🔑 ${c.code}
⏳ ${c.days} يوم
📌 مستخدم: ${c.used ? 'نعم' : 'لا'}

`;
  }

  await bot.sendMessage(msg.chat.id, text);
});

bot.onText(/^\/users$/i, async (msg) => {
  if (!isAdmin(msg.from.id)) return;

  const { data, error } = await supabase
    .from('subscribers')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(50);

  if (error || !data || !data.length) {
    return bot.sendMessage(msg.chat.id, '❌ لا يوجد مشتركين.');
  }

  let text = '👥 المشتركين:\n\n';

  for (const u of data) {
    const days = await remainingDays(u.user_id);
    text += `🆔 ${u.user_id}
⏳ المتبقي: ${days} يوم

`;
  }

  await bot.sendMessage(msg.chat.id, text);
});

bot.onText(/^\/remove\s+(\d+)$/i, async (msg, match) => {
  if (!isAdmin(msg.from.id)) return;

  const targetId = match[1];

  await supabase
    .from('subscribers')
    .delete()
    .eq('user_id', String(targetId));

  await bot.sendMessage(msg.chat.id, `✅ تم حذف المستخدم ${targetId}`);
});

async function activateCode(code, userId, chatId) {
  const { data, error } = await supabase
    .from('invite_codes')
    .select('*')
    .eq('code', code)
    .single();

  if (error || !data) return false;

  if (data.used) {
    await bot.sendMessage(chatId, '❌ الكود مستخدم مسبقًا.');
    return true;
  }

  const expiresAt = Date.now() + data.days * 24 * 60 * 60 * 1000;

  await supabase.from('subscribers').upsert({
    user_id: String(userId),
    expires_at: expiresAt
  });

  await supabase
    .from('invite_codes')
    .update({
      used: true,
      used_by: String(userId),
      used_at: new Date().toISOString()
    })
    .eq('code', code);

  await bot.sendMessage(
    chatId,
    `✅ تم تفعيل اشتراكك

⏳ المدة: ${data.days} يوم
📅 المتبقي: ${data.days} يوم`
  );

  return true;
}

// =====================
// Massive API
// =====================

async function getOptionSnapshot(symbol) {
  let url = `https://api.massive.com/v3/snapshot/options/${symbol}`;
  let results = [];

  while (url) {
    const res = await axios.get(url, {
      params: url.includes('?') ? {} : { apiKey: API_KEY, limit: 250 },
      timeout: 25000
    });

    results = results.concat(res.data.results || []);

    if (res.data.next_url) {
      url = `${res.data.next_url}&apiKey=${API_KEY}`;
    } else {
      url = null;
    }

    if (results.length >= 1000) break;
  }

  return { results };
}

async function getStockBars(symbol) {
  const to = getTodayISODateNY();
  const from = getISODateDaysAgoNY(STOCK_BARS_LOOKBACK_DAYS);

  const res = await axios.get(
    `https://api.massive.com/v2/aggs/ticker/${encodeURIComponent(symbol)}/range/${STOCK_BAR_MINUTES}/minute/${from}/${to}`,
    {
      params: {
        apiKey: API_KEY,
        adjusted: true,
        sort: 'asc',
        limit: 5000
      },
      timeout: 20000
    }
  );

  return (res.data.results || []).map(x => ({
    time: x.t,
    open: safeNumber(x.o),
    high: safeNumber(x.h),
    low: safeNumber(x.l),
    close: safeNumber(x.c),
    volume: safeNumber(x.v)
  }));
}

async function getOptionTrades(optionsTicker) {
  const today = getTodayISODateNY();

  const res = await axios.get(
    `https://api.massive.com/v3/trades/${encodeURIComponent(optionsTicker)}`,
    {
      params: {
        apiKey: API_KEY,
        timestamp: today,
        order: 'desc',
        limit: FLOW_TRADE_LIMIT
      },
      timeout: 15000
    }
  );

  return res.data.results || [];
}

async function getOptionQuotes(optionsTicker) {
  const today = getTodayISODateNY();

  const res = await axios.get(
    `https://api.massive.com/v3/quotes/${encodeURIComponent(optionsTicker)}`,
    {
      params: {
        apiKey: API_KEY,
        timestamp: today,
        order: 'desc',
        limit: FLOW_QUOTE_LIMIT
      },
      timeout: 15000
    }
  );

  return res.data.results || [];
}
// =====================
// Technical Stop
// =====================

function isSwingLow(bars, i, lr) {
  const low = bars[i].low;

  for (let x = i - lr; x <= i + lr; x++) {
    if (x === i) continue;
    if (!bars[x]) return false;
    if (bars[x].low <= low) return false;
  }

  return true;
}

function isSwingHigh(bars, i, lr) {
  const high = bars[i].high;

  for (let x = i - lr; x <= i + lr; x++) {
    if (x === i) continue;
    if (!bars[x]) return false;
    if (bars[x].high >= high) return false;
  }

  return true;
}

function findLastSwingLow(bars, maxPrice = Infinity) {
  for (let i = bars.length - 1 - SWING_LEFT_RIGHT; i >= SWING_LEFT_RIGHT; i--) {
    if (isSwingLow(bars, i, SWING_LEFT_RIGHT) && bars[i].low < maxPrice) {
      return bars[i].low;
    }
  }

  const recent = bars.slice(-30).filter(b => b.low < maxPrice);
  if (!recent.length) return null;

  return Math.min(...recent.map(b => b.low));
}

function findLastSwingHigh(bars, minPrice = 0) {
  for (let i = bars.length - 1 - SWING_LEFT_RIGHT; i >= SWING_LEFT_RIGHT; i--) {
    if (isSwingHigh(bars, i, SWING_LEFT_RIGHT) && bars[i].high > minPrice) {
      return bars[i].high;
    }
  }

  const recent = bars.slice(-30).filter(b => b.high > minPrice);
  if (!recent.length) return null;

  return Math.max(...recent.map(b => b.high));
}

function calculateTechnicalStop(bars, bias, entry, spot) {
  if (!bars || bars.length < 20 || !entry) {
    return {
      price: null,
      source: 'غير متاح',
      valid: false
    };
  }

  if (bias === 'CALL') {
    const swingLow = findLastSwingLow(bars, entry);

    if (!swingLow) {
      return { price: null, source: 'لم يتم العثور على قاع فني', valid: false };
    }

    const stop = swingLow * (1 - TECH_STOP_BUFFER_PCT);
    const riskPct = Math.abs((entry - stop) / entry) * 100;

    return {
      price: stop,
      source: 'آخر قاع فني قبل الاختراق',
      valid: riskPct <= 4,
      riskPct
    };
  }

  if (bias === 'PUT') {
    const swingHigh = findLastSwingHigh(bars, entry);

    if (!swingHigh) {
      return { price: null, source: 'لم يتم العثور على قمة فنية', valid: false };
    }

    const stop = swingHigh * (1 + TECH_STOP_BUFFER_PCT);
    const riskPct = Math.abs((stop - entry) / entry) * 100;

    return {
      price: stop,
      source: 'آخر قمة فنية قبل الكسر',
      valid: riskPct <= 4,
      riskPct
    };
  }

  return {
    price: null,
    source: 'Neutral',
    valid: false
  };
}

// =====================
// GEX Core
// =====================

function getExpirationInfo(results) {
  const expirations = [
    ...new Set(results.map(x => x.details?.expiration_date).filter(Boolean))
  ].sort();

  return {
    nearestExpiration: expirations[0] || 'N/A',
    farthestExpiration: expirations[expirations.length - 1] || 'N/A',
    expirationCount: expirations.length
  };
}

function isNearSpot(strike, spot) {
  if (!spot) return true;
  return Math.abs(strike - spot) / spot <= NEAR_SPOT_RANGE;
}

function selectTopLevels(rows, spot, side, count = 3) {
  if (!rows.length || !spot) return [];

  const maxAbs = Math.max(...rows.map(r => Math.abs(r.netGex)), 1);
  const minStrength = maxAbs * 0.03;

  let filtered;

  if (side === 'resistance') {
    filtered = rows
      .filter(r => r.strike >= spot && Math.abs(r.netGex) >= minStrength)
      .sort((a, b) => a.strike - b.strike);
  } else {
    filtered = rows
      .filter(r => r.strike <= spot && Math.abs(r.netGex) >= minStrength)
      .sort((a, b) => b.strike - a.strike);
  }

  return filtered.slice(0, count);
}

function calculateNewPositions(volume, oi) {
  if (!volume || !oi) {
    return { label: 'غير واضح', ratio: 0, score: 0 };
  }

  const ratio = volume / oi;

  if (ratio >= 2.5) return { label: 'مرتفع', ratio, score: 2 };
  if (ratio >= 1.2) return { label: 'متوسط', ratio, score: 1 };
  return { label: 'ضعيف', ratio, score: 0 };
}

function calculateGex(data) {
  const results = data.results || [];
  const expInfo = getExpirationInfo(results);

  const byStrike = {};
  const flowContracts = [];

  let spot = null;
  let totalGex = 0;
  let totalDex = 0;

  let callVolume = 0;
  let putVolume = 0;
  let totalVolume = 0;
  let totalOI = 0;

  for (const item of results) {
    const details = item.details || {};
    const greeks = item.greeks || {};

    const strike = safeNumber(details.strike_price, null);
    const type = String(details.contract_type || '').toLowerCase();

    const gamma = safeNumber(greeks.gamma, 0);
    const delta = safeNumber(greeks.delta, 0);
    const oi = safeNumber(item.open_interest, 0);
    const volume = safeNumber(item.day?.volume ?? item.volume, 0);
    const ticker = getContractTicker(item);

    if (!spot && item.underlying_asset?.price) {
      spot = safeNumber(item.underlying_asset.price, null);
    }

    if (!strike || !type) continue;

    if (!byStrike[strike]) {
      byStrike[strike] = {
        strike,
        callGex: 0,
        putGex: 0,
        netGex: 0,
        callVolume: 0,
        putVolume: 0,
        volume: 0,
        oi: 0
      };
    }

    if (oi && gamma) {
      const rawGex = oi * gamma * 100;
      const signedGex = type === 'put' ? -rawGex : rawGex;

      if (type === 'call') byStrike[strike].callGex += rawGex;
      if (type === 'put') byStrike[strike].putGex += rawGex;

      byStrike[strike].netGex += signedGex;
      totalGex += signedGex;
    }

    if (oi && delta) {
      totalDex += delta * oi * 100;
    }

    if (type === 'call') {
      callVolume += volume;
      byStrike[strike].callVolume += volume;
    }

    if (type === 'put') {
      putVolume += volume;
      byStrike[strike].putVolume += volume;
    }

    byStrike[strike].volume += volume;
    byStrike[strike].oi += oi;

    totalVolume += volume;
    totalOI += oi;

    if (ticker && isNearSpot(strike, spot)) {
      flowContracts.push({
        ticker,
        type,
        strike,
        oi,
        volume,
        gamma,
        delta,
        score: Math.abs(gamma * oi * 100) + volume
      });
    }
  }

  const rows = Object.values(byStrike).sort((a, b) => a.strike - b.strike);

  if (!rows.length) throw new Error('NO_GEX_DATA');

  const nearbyRows = rows.filter(r => isNearSpot(r.strike, spot));
  const sourceRows = nearbyRows.length ? nearbyRows : rows;

  const resistances = selectTopLevels(sourceRows, spot, 'resistance', 3);
  const supports = selectTopLevels(sourceRows, spot, 'support', 3);

  const callWall =
    resistances[0] ||
    sourceRows.filter(r => r.strike >= spot).sort((a, b) => Math.abs(b.netGex) - Math.abs(a.netGex))[0] ||
    sourceRows[0];

  const putWall =
    supports[0] ||
    sourceRows.filter(r => r.strike <= spot).sort((a, b) => Math.abs(b.netGex) - Math.abs(a.netGex))[0] ||
    sourceRows[0];

  const flip = sourceRows.reduce((a, b) =>
    Math.abs(b.netGex) < Math.abs(a.netGex) ? b : a
  );

  const topLevels = sourceRows
    .slice()
    .sort((a, b) => Math.abs(b.netGex) - Math.abs(a.netGex))
    .slice(0, 5);

  const strongestWall = Math.max(
    Math.abs(callWall?.netGex || 0),
    Math.abs(putWall?.netGex || 0),
    1
  );

  const flowCandidates = flowContracts
    .filter(c => c.ticker && c.volume > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, FLOW_MAX_CONTRACTS);

  const volumeTotal = callVolume + putVolume;
  const callFlowPct = pct(callVolume, volumeTotal);
  const putFlowPct = pct(putVolume, volumeTotal);

  const newPositions = calculateNewPositions(totalVolume, totalOI);

  return {
    spot,
    nearestExpiration: expInfo.nearestExpiration,
    farthestExpiration: expInfo.farthestExpiration,
    expirationCount: expInfo.expirationCount,

    totalGex,
    totalDex,
    gammaRegime: totalGex >= 0 ? 'Positive Gamma' : 'Negative Gamma',

    callVolume,
    putVolume,
    callFlowPct,
    putFlowPct,

    totalVolume,
    totalOI,
    newPositions,

    callWall,
    putWall,
    resistances,
    supports,
    flip,
    topLevels,

    flowCandidates,

    callStrengthRatio: Math.abs(callWall.netGex) / strongestWall,
    putStrengthRatio: Math.abs(putWall.netGex) / strongestWall
  };
}
// =====================
// Real Ask/Bid Flow
// =====================

function findNearestQuote(tradeTs, quotesAsc) {
  let nearest = null;

  for (const q of quotesAsc) {
    const qTs = getTs(q);
    if (!qTs) continue;

    if (qTs <= tradeTs) nearest = q;
    else break;
  }

  return nearest || quotesAsc[quotesAsc.length - 1] || null;
}

function classifyTradeByQuote(trade, quote) {
  const price = getTradePrice(trade);
  const size = getTradeSize(trade);
  const bid = getBid(quote);
  const ask = getAsk(quote);

  if (!price || !size || !bid || !ask || ask <= bid) {
    return { side: 'neutral', size: 0 };
  }

  const spread = ask - bid;
  const tolerance = Math.max(spread * 0.15, 0.01);

  if (price >= ask - tolerance) return { side: 'ask', size };
  if (price <= bid + tolerance) return { side: 'bid', size };

  return { side: 'neutral', size };
}

async function calculateRealAskBidFlow(contracts) {
  if (!FLOW_ENABLED || !contracts || !contracts.length) {
    return {
      enabled: false,
      askVolume: 0,
      bidVolume: 0,
      neutralVolume: 0,
      askPct: 0,
      bidPct: 0,
      neutralPct: 0,
      contractsChecked: 0
    };
  }

  let askVolume = 0;
  let bidVolume = 0;
  let neutralVolume = 0;
  let contractsChecked = 0;

  const sinceMs = Date.now() - FLOW_LOOKBACK_MINUTES * 60 * 1000;
  const sinceNs = sinceMs * 1_000_000;

  for (const c of contracts) {
    try {
      const [tradesRaw, quotesRaw] = await Promise.all([
        getOptionTrades(c.ticker),
        getOptionQuotes(c.ticker)
      ]);

      const trades = tradesRaw
        .filter(t => getTs(t) >= sinceNs)
        .sort((a, b) => getTs(a) - getTs(b));

      const quotesAsc = quotesRaw
        .filter(q => getTs(q) >= sinceNs)
        .sort((a, b) => getTs(a) - getTs(b));

      if (!trades.length || !quotesAsc.length) continue;

      contractsChecked++;

      for (const trade of trades) {
        const quote = findNearestQuote(getTs(trade), quotesAsc);
        const classified = classifyTradeByQuote(trade, quote);

        if (classified.side === 'ask') askVolume += classified.size;
        else if (classified.side === 'bid') bidVolume += classified.size;
        else neutralVolume += classified.size;
      }
    } catch (err) {
      console.error(`FLOW ERROR ${c.ticker}:`, err.response?.data || err.message);
    }
  }

  const total = askVolume + bidVolume + neutralVolume;

  return {
    enabled: true,
    askVolume,
    bidVolume,
    neutralVolume,
    askPct: pct(askVolume, total),
    bidPct: pct(bidVolume, total),
    neutralPct: pct(neutralVolume, total),
    contractsChecked
  };
}

// =====================
// Score + Trade Plan
// =====================

function hasValidRealFlow(a) {
  return (
    a.realFlow?.enabled &&
    a.realFlow.contractsChecked > 0 &&
    (a.realFlow.askVolume + a.realFlow.bidVolume + a.realFlow.neutralVolume) > 0
  );
}

function calculateScore(a) {
  let callScore = 0;
  let putScore = 0;
  const reasons = [];

  const aboveFlip = a.spot > a.flip.strike;
  const flipDistance = Math.abs(distancePercent(a.spot, a.flip.strike) || 0);

  if (aboveFlip) {
    callScore += 3;
    reasons.push('✅ السعر فوق Gamma Flip');
  } else {
    putScore += 3;
    reasons.push('✅ السعر تحت Gamma Flip');
  }

  if (a.totalDex > 0) {
    callScore += 2;
    reasons.push('✅ DEX موجب');
  } else if (a.totalDex < 0) {
    putScore += 2;
    reasons.push('✅ DEX سلبي');
  }

  if (a.callFlowPct > a.putFlowPct + 10) {
    callScore += 2;
    reasons.push('✅ Call Flow أعلى من Put Flow');
  } else if (a.putFlowPct > a.callFlowPct + 10) {
    putScore += 2;
    reasons.push('✅ Put Flow أعلى من Call Flow');
  }

  if (hasValidRealFlow(a)) {
    if (a.realFlow.askPct > a.realFlow.bidPct + 10) {
      callScore += 2;
      reasons.push('✅ Ask Flow أعلى من Bid Flow');
    } else if (a.realFlow.bidPct > a.realFlow.askPct + 10) {
      putScore += 2;
      reasons.push('✅ Bid Flow أعلى من Ask Flow');
    }
  }

  if (a.newPositions.score >= 2) {
    if (a.callFlowPct >= a.putFlowPct) callScore += 1;
    else putScore += 1;
    reasons.push('✅ دخول مراكز جديدة مرتفع');
  }

  if (a.gammaRegime === 'Positive Gamma') {
    callScore += 1;
    reasons.push('✅ Gamma Regime إيجابي');
  } else {
    putScore += 1;
    reasons.push('✅ Gamma Regime سلبي');
  }

  let bias = 'NEUTRAL';
  let confidence = Math.max(callScore, putScore);

  if (Math.abs(callScore - putScore) >= 3 && confidence >= 6) {
    bias = callScore > putScore ? 'CALL' : 'PUT';
  }

  if (flipDistance >= 5 && callScore > putScore && !aboveFlip) {
    confidence = Math.max(1, confidence - 2);
    reasons.push('⚠️ السعر بعيد وتحت Gamma Flip، تم تخفيض الثقة');
  }

  if (flipDistance >= 5 && putScore > callScore && aboveFlip) {
    confidence = Math.max(1, confidence - 2);
    reasons.push('⚠️ السعر بعيد وفوق Gamma Flip، تم تخفيض الثقة');
  }

  if (confidence < 6) {
    bias = 'NEUTRAL';
  }

  return {
    bias,
    callScore,
    putScore,
    confidence: clamp(confidence, 1, 10),
    reasons
  };
}

function extendTarget(level2, level3) {
  if (!level2 || !level3) return 'N/A';
  const step = Math.abs(Number(level3) - Number(level2));
  if (!step) return 'N/A';
  return Number(level3) + step;
}

function buildTradePlan(a) {
  const score = a.scoreData;

  const r1 = a.resistances[0];
  const r2 = a.resistances[1];
  const r3 = a.resistances[2];

  const s1 = a.supports[0];
  const s2 = a.supports[1];
  const s3 = a.supports[2];

  if (score.bias === 'CALL') {
    const entry = r1?.strike || null;
    const tp1 = r2?.strike || r1?.strike || 'N/A';
    const tp2 = r3?.strike || 'N/A';
    const tp3 = r2 && r3 ? extendTarget(r2.strike, r3.strike) : 'N/A';

    return {
      direction: '🟢 CALL BIAS',
      entryText: entry ? `اختراق ${entry} والثبات فوقه` : 'غير واضح',
      entry,
      tp1,
      tp2,
      tp3,
      alt1: s1?.strike || 'N/A',
      alt2: s2?.strike || 'N/A'
    };
  }

  if (score.bias === 'PUT') {
    const entry = s1?.strike || null;
    const tp1 = s2?.strike || s1?.strike || 'N/A';
    const tp2 = s3?.strike || 'N/A';
    const tp3 = s2 && s3 ? Number(s3.strike) - Math.abs(Number(s2.strike) - Number(s3.strike)) : 'N/A';

    return {
      direction: '🔴 PUT BIAS',
      entryText: entry ? `كسر ${entry} والثبات تحته` : 'غير واضح',
      entry,
      tp1,
      tp2,
      tp3,
      alt1: r1?.strike || 'N/A',
      alt2: r2?.strike || 'N/A'
    };
  }

  return {
    direction: '⚪ NEUTRAL',
    entryText: 'لا يوجد دخول واضح بسبب تعارض البيانات',
    entry: null,
    tp1: 'N/A',
    tp2: 'N/A',
    tp3: 'N/A',
    alt1: 'N/A',
    alt2: 'N/A'
  };
}

// =====================
// Analysis
// =====================

async function analyzeGex(symbol) {
  const cacheKey = `${symbol}-${EXPIRATION_MODE}`;
  const cached = gexCache.get(cacheKey);

  if (cached && Date.now() - cached.time < CACHE_MS) {
    return cached.data;
  }

  const [data, bars] = await Promise.all([
    getOptionSnapshot(symbol),
    getStockBars(symbol).catch(err => {
      console.error(`BARS ERROR ${symbol}:`, err.response?.data || err.message);
      return [];
    })
  ]);

  const analysis = calculateGex(data);

  analysis.realFlow = await calculateRealAskBidFlow(analysis.flowCandidates);
  analysis.scoreData = calculateScore(analysis);
  analysis.tradePlan = buildTradePlan(analysis);

  analysis.technicalStop = calculateTechnicalStop(
    bars,
    analysis.scoreData.bias,
    analysis.tradePlan.entry,
    analysis.spot
  );

  gexCache.set(cacheKey, {
    time: Date.now(),
    data: analysis
  });

  return analysis;
}
// =====================
// Message
// =====================

function buildMiniChart(levels) {
  return levels
    .map(l => {
      const icon = l.netGex >= 0 ? '🟩' : '🟥';
      return `${icon} سترايك ${l.strike} | ${fmt(l.netGex)}`;
    })
    .join('\n');
}

function buildResistanceList(a) {
  if (!a.resistances.length) return 'لا توجد مقاومات كافية';

  return a.resistances.map((l, i) => {
    return `R${i + 1}️⃣ ${l.strike}
القوة: ${l.netGex >= 0 ? '+' : ''}${fmt(l.netGex)}
المسافة: ${fmtPercent(distancePercent(a.spot, l.strike))}`;
  }).join('\n\n');
}

function buildSupportList(a) {
  if (!a.supports.length) return 'لا توجد مستويات سفلية كافية';

  return a.supports.map((l, i) => {
    return `S${i + 1}️⃣ ${l.strike}
القوة: ${l.netGex >= 0 ? '+' : ''}${fmt(l.netGex)}
المسافة: ${fmtPercent(distancePercent(a.spot, l.strike))}`;
  }).join('\n\n');
}

function buildStopText(a) {
  if (a.scoreData.bias === 'NEUTRAL') return 'لا يوجد وقف لأن الحالة Neutral';

  if (!a.technicalStop?.price) {
    return `غير متاح
📌 السبب: ${a.technicalStop?.source || 'لا توجد شموع كافية'}`;
  }

  return `${fmtPrice(a.technicalStop.price)}
📌 ${a.technicalStop.source}
📏 المخاطرة الفنية: ${fmtPercent(a.technicalStop.riskPct || 0)}`;
}

function buildFlowText(a) {
  if (hasValidRealFlow(a)) {
    return `🟢 Ask Flow: ${fmtPercent(a.realFlow.askPct)}
🔴 Bid Flow: ${fmtPercent(a.realFlow.bidPct)}
⚪ Neutral: ${fmtPercent(a.realFlow.neutralPct)}
📌 محسوبة من آخر ${FLOW_LOOKBACK_MINUTES} دقيقة على ${a.realFlow.contractsChecked} عقود`;
  }

  return `🟢 Ask/Bid Flow:
غير متاح حاليًا

📌 قد يظهر 0 إذا كان السوق مغلق أو لا توجد Trades/Quotes كافية خلال آخر ${FLOW_LOOKBACK_MINUTES} دقيقة`;
}

function buildMessage(symbol, a) {
  const score = a.scoreData;
  const plan = a.tradePlan;

  const r1 = a.resistances[0];
  const s1 = a.supports[0];

  const gammaIcon = a.gammaRegime === 'Positive Gamma' ? '🟢' : '🔴';

  const controller =
    score.bias === 'CALL'
      ? 'المشترون'
      : score.bias === 'PUT'
        ? 'البائعون'
        : 'غير واضح';

  return `🚨 ST Smart Flow Alert

📊 السهم: ${symbol}
💵 السعر الحالي: ${fmtPrice(a.spot)}

━━━━━━━━━━━━━━
🚀 الخلاصة السريعة
━━━━━━━━━━━━━━

📊 الاتجاه: ${plan.direction}
🔥 الثقة: ${fmt(score.confidence)} / 10

📍 الدخول:
${plan.entryText}

🎯 TP1: ${plan.tp1}
🎯 TP2: ${plan.tp2}
🎯 TP3: ${plan.tp3}

🛑 الوقف الفني:
${buildStopText(a)}

━━━━━━━━━━━━━━
🧠 حالة السوق
━━━━━━━━━━━━━━

${gammaIcon} Gamma Regime:
${a.gammaRegime}

🎯 Gamma Flip:
${a.flip.strike}

📈 DEX:
${a.totalDex >= 0 ? '+' : ''}${fmtCompact(a.totalDex)}

📦 فتح مراكز جديدة:
${a.newPositions.label}
Volume/OI: ${fmt(a.newPositions.ratio)}x

━━━━━━━━━━━━━━
💰 تدفق السيولة
━━━━━━━━━━━━━━

🟢 Call Flow: ${fmtPercent(a.callFlowPct)}
🔴 Put Flow: ${fmtPercent(a.putFlowPct)}

${buildFlowText(a)}

👑 الطرف المسيطر:
${controller}

🔥 قوة السيطرة:
${fmt(score.confidence)} / 10

━━━━━━━━━━━━━━
🟩 مقاومات الجاما
━━━━━━━━━━━━━━

${buildResistanceList(a)}

━━━━━━━━━━━━━━
🟥 مستويات جاما سفلية
━━━━━━━━━━━━━━

${buildSupportList(a)}

━━━━━━━━━━━━━━
📍 موقع السعر
━━━━━━━━━━━━━━

السعر الآن بين:
🟥 S1: ${s1?.strike || 'N/A'}
🟩 R1: ${r1?.strike || 'N/A'}

النطاق الحالي:
${s1?.strike || 'N/A'} ➜ ${r1?.strike || 'N/A'}

━━━━━━━━━━━━━━
📊 أقوى مستويات الجاما القريبة
━━━━━━━━━━━━━━

${buildMiniChart(a.topLevels)}

━━━━━━━━━━━━━━
📌 أسباب الاتجاه
━━━━━━━━━━━━━━

${score.reasons.join('\n')}

━━━━━━━━━━━━━━
⚠️ السيناريو البديل
━━━━━━━━━━━━━━

في حال فشل الاتجاه الحالي:

🎯 Level 1: ${plan.alt1}
🎯 Level 2: ${plan.alt2}

━━━━━━━━━━━━━━
📌 القرار النهائي
━━━━━━━━━━━━━━

${plan.direction}
📊 Score: ${fmt(score.confidence)} / 10

⚠️ ليست توصية شراء أو بيع`;
}

// =====================
// Manual Requests
// =====================

bot.on('message', async (msg) => {
  const msgKey = `${msg.chat.id}-${msg.message_id}`;

  if (processedMessages.has(msgKey)) return;
  processedMessages.add(msgKey);

  setTimeout(() => {
    processedMessages.delete(msgKey);
  }, 5 * 60 * 1000);

  try {
    if (!msg.text) return;
    if (msg.text.startsWith('/')) return;

    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const text = msg.text.trim().toUpperCase();

    if (text.startsWith('ST-')) {
      const activated = await activateCode(text, userId, chatId);
      if (activated) return;
    }

    if (!isValidSymbol(text)) return;

    const scanKey = `${chatId}-${text}`;

    if (activeManualScans.has(scanKey)) {
      return;
    }

    activeManualScans.add(scanKey);

    try {
      const active = await hasActiveSubscription(userId);

      if (!active) {
        return bot.sendMessage(
          chatId,
          '❌ لا تملك اشتراك فعال.\n\nراسل الإدارة للحصول على كود تفعيل.'
        );
      }

      const last = userCooldown.get(chatId);

      if (last && Date.now() - last < USER_COOLDOWN_MS) {
        return bot.sendMessage(chatId, '⏳ انتظر 15 ثانية قبل طلب سهم جديد.');
      }

      userCooldown.set(chatId, Date.now());

      await bot.sendMessage(chatId, `⏳ جاري تحليل Smart Flow لـ ${text}...`);

      const analysis = await analyzeGex(text);

      const reportText = buildMessage(analysis);

await bot.sendMessage(
  chatId,
  reportText
);

if (process.env.DECISION_GROUP_ID) {
  await bot.sendMessage(
    process.env.DECISION_GROUP_ID,
    reportText
  );
}
    } finally {
      activeManualScans.delete(scanKey);
    }
  } catch (err) {
    console.error('MANUAL ERROR:', err.response?.data || err.message);
    await bot.sendMessage(msg.chat.id, '❌ لم أستطع جلب بيانات GEX لهذا الرمز.');
  }
});
// =====================
// Auto Scan
// =====================

async function autoScan() {
  if (!ADMIN_CHAT_ID) return;
  if (!WATCHLIST.length) return;

  const symbol = WATCHLIST[autoScanIndex % WATCHLIST.length];
  autoScanIndex++;

  try {
    const a = await analyzeGex(symbol);

    if (!a.spot) return;

    const r1 = a.resistances[0];
    const s1 = a.supports[0];

    const nearResistance =
      r1 &&
      Math.abs(a.spot - r1.strike) / a.spot <= 0.005;

    const nearSupport =
      s1 &&
      Math.abs(a.spot - s1.strike) / a.spot <= 0.005;

    const nearFlip =
      Math.abs(a.spot - a.flip.strike) / a.spot <= 0.005;

    const strongScore = a.scoreData.confidence >= 7 && a.scoreData.bias !== 'NEUTRAL';

    if (!nearResistance && !nearSupport && !nearFlip && !strongScore) return;

    const reason = [
      nearResistance ? `🟩 قريب من مقاومة جاما ${r1.strike}` : null,
      nearSupport ? `🟥 قريب من مستوى جاما سفلي ${s1.strike}` : null,
      nearFlip ? `🎯 قريب من Gamma Flip ${a.flip.strike}` : null,
      strongScore ? `🔥 Score قوي ${fmt(a.scoreData.confidence)} / 10` : null
    ].filter(Boolean).join('\n');

    const key = `${symbol}-${reason}`;
    const last = lastAlert.get(key);

    if (last && Date.now() - last < ALERT_COOLDOWN_MS) return;

    lastAlert.set(key, Date.now());

    await bot.sendMessage(
      ADMIN_CHAT_ID,
      `🚨 تنبيه تلقائي Smart Flow\n\n${reason}\n\n${buildMessage(symbol, a)}`
    );
  } catch (err) {
    console.error(`AUTO ERROR ${symbol}:`, err.response?.data || err.message);
  }
}

// =====================
// Market Time
// =====================

function isMarketOpenNY() {
  const now = new Date();

  const nyTime = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    weekday: 'short'
  }).formatToParts(now);

  const get = type => nyTime.find(p => p.type === type)?.value;

  const day = get('weekday');
  const hour = Number(get('hour'));
  const minute = Number(get('minute'));

  if (day === 'Sat' || day === 'Sun') return false;

  const totalMinutes = hour * 60 + minute;

  const marketOpen = 9 * 60 + 30;
  const marketClose = 16 * 60;

  return totalMinutes >= marketOpen && totalMinutes <= marketClose;
}

// =====================
// Start Bot
// =====================

bot.sendMessage(
  ADMIN_CHAT_ID,
  '✅ ST Smart Flow Bot اشتغل: وقف فني + Neutral + DEX + Flow'
).catch(err => {
  console.error('START MESSAGE ERROR:', err.message);
});

setInterval(() => {
  if (isMarketOpenNY()) {
    autoScan();
  } else {
    console.log('AUTO SCAN OFF: Market closed');
  }
}, AUTO_SCAN_MS);

if (isMarketOpenNY()) {
  autoScan();
}

console.log('🚀 ST Smart Flow Stocks Bot Started');
