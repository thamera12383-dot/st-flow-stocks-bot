const WebSocket = require('ws');

const API_KEY = process.env.MASSIVE_API_KEY;

const ws = new WebSocket(
  `wss://socket.massive.com/options`
);

ws.on('open', () => {

  console.log('✅ Connected To Massive');

  ws.send(JSON.stringify({
    action: 'auth',
    params: API_KEY
  }));

  ws.send(JSON.stringify({
    action: 'subscribe',
    params: 'T.*'
  }));

});

ws.on('message', (data) => {

  try {

    const messages = JSON.parse(data);

    for (const msg of messages) {

      if (msg.ev !== 'T') continue;

      console.log(`
========================
📡 LIVE OPTIONS FLOW
========================

📌 Symbol:
${msg.sym}

💰 Price:
${msg.p}

📦 Size:
${msg.s}

🕒 Time:
${new Date(msg.t).toLocaleTimeString()}

========================
`);

    }

  } catch (err) {

    console.error(err.message);

  }

});

ws.on('error', (err) => {

  console.error('❌ WS Error:', err.message);

});

ws.on('close', () => {

  console.log('🔌 Connection Closed');

});
