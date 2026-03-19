// ============================================
// PRINTDUAN SERVER v4
// ============================================
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const low = require('lowdb');
const FileSync = require('lowdb/adapters/FileSync');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const PORT = process.env.PORT || 3000;

// ── DATABASE ──
const adapter = new FileSync(path.join(__dirname, 'db.json'));
const db = low(adapter);
db.defaults({ orders: [], logs: [] }).write();

// ── FOLDERS ──
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const PUBLIC_DIR = fs.existsSync(path.join(__dirname, 'public'))
  ? path.join(__dirname, 'public') : __dirname;
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR);

// ── MIDDLEWARE ──
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(PUBLIC_DIR));
app.use('/uploads', express.static(UPLOADS_DIR));
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ── UPLOAD ──
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const unique = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, unique + path.extname(file.originalname));
  }
});
const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } });

// ── STATE ──
let sessions = {};
let kioskClients = {};

function genId() { return 'PD' + crypto.randomBytes(3).toString('hex').toUpperCase(); }

function addLog(type, msg) {
  db.get('logs').push({ id: genId(), type, msg, time: new Date().toISOString() }).write();
  const logs = db.get('logs').value();
  if (logs.length > 300) db.set('logs', logs.slice(-300)).write();
}

// ── WEBSOCKET ──
wss.on('connection', (ws, req) => {
  const params = new URLSearchParams(req.url.replace('/?',''));
  const kioskId = params.get('kiosk') || 'kiosk-01';
  kioskClients[kioskId] = ws;
  addLog('info', `Kiosk connected: ${kioskId}`);

  ws.on('message', msg => {
    try {
      const data = JSON.parse(msg);
      if (data.type === 'ping') ws.send(JSON.stringify({ type: 'pong' }));
      if (data.type === 'print_ready') {
        db.get('orders').find({ id: data.orderId })
          .assign({ status: 'printing', updatedAt: new Date().toISOString() }).write();
      }
    } catch(e) {}
  });

  ws.on('close', () => {
    delete kioskClients[kioskId];
    addLog('warn', `Kiosk disconnected: ${kioskId}`);
  });

  ws.send(JSON.stringify({ type: 'connected', kioskId }));
});

function notifyKiosk(kioskId, msg) {
  const ws = kioskClients[kioskId];
  if (ws && ws.readyState === WebSocket.OPEN) { ws.send(JSON.stringify(msg)); return true; }
  return false;
}

// ── PAGES ──
app.get('/', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'mobile.html')));
app.get('/kiosk', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'kiosk.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'admin.html')));

// ── SESSION ──
app.post('/api/session/create', (req, res) => {
  const { kioskId = 'kiosk-01', type = 'login' } = req.body;
  const sessionId = genId();
  sessions[sessionId] = { id: sessionId, kioskId, type, status: 'pending', files: [], createdAt: new Date().toISOString() };
  res.json({ success: true, sessionId });
});

app.get('/api/session/:id', (req, res) => {
  const s = sessions[req.params.id];
  if (!s) return res.status(404).json({ error: 'Not found' });
  res.json(s);
});

// ── LOGIN ──
app.post('/api/login', (req, res) => {
  const { sessionId, kioskId = 'kiosk-01' } = req.body;
  const s = sessions[sessionId];
  if (s) s.status = 'authenticated';
  addLog('success', `Login: ${sessionId}`);
  notifyKiosk(kioskId, { type: 'unlock', sessionId });
  res.json({ success: true });
});

// ── UPLOAD ──
app.post('/api/upload', upload.array('files', 10), (req, res) => {
  const { sessionId, kioskId = 'kiosk-01' } = req.body;
  if (!req.files?.length) return res.status(400).json({ error: 'No files' });

  const files = req.files.map(f => ({
    id: genId(), name: f.originalname, filename: f.filename,
    size: f.size, path: `/uploads/${f.filename}`, uploadedAt: new Date().toISOString()
  }));

  if (sessionId && sessions[sessionId]) {
    sessions[sessionId].files.push(...files);
    sessions[sessionId].status = 'files_ready';
  }

  addLog('info', `Upload: ${files.length} file(s)`);
  notifyKiosk(kioskId, { type: 'files_ready', sessionId, files: files.map(f => ({ name: f.name, size: f.size })) });
  res.json({ success: true, files });
});

// ── ORDERS ──
app.post('/api/order/create', (req, res) => {
  const { sessionId, kioskId = 'kiosk-01', service, size, color, copies, amount } = req.body;
  const order = {
    id: genId(), sessionId, kioskId,
    service: service || 'Document Print',
    size: size || 'A4', color: color || 'B&W',
    copies: parseInt(copies) || 1,
    amount: parseInt(amount) || 500,
    status: 'pending', paymentMethod: null,
    createdAt: new Date().toISOString()
  };
  db.get('orders').push(order).write();
  addLog('info', `Order: ${order.id} — ${order.service} — ${order.amount} LAK`);
  res.json({ success: true, orderId: order.id, order });
});

app.get('/api/order/:id', (req, res) => {
  const o = db.get('orders').find({ id: req.params.id }).value();
  if (!o) return res.status(404).json({ error: 'Not found' });
  res.json(o);
});

app.get('/api/orders', (req, res) => {
  const orders = db.get('orders').value().slice().reverse();
  res.json({ orders, total: orders.length });
});

app.delete('/api/orders', (req, res) => {
  db.set('orders', []).write();
  addLog('warn', 'All orders cleared by admin');
  res.json({ success: true });
});

// ── PAYMENT ──
app.post('/api/payment/confirm', (req, res) => {
  const { orderId, method, kioskId = 'kiosk-01' } = req.body;
  const order = db.get('orders').find({ id: orderId }).value();
  if (!order) return res.status(404).json({ error: 'Not found' });

  db.get('orders').find({ id: orderId }).assign({
    status: 'paid', paymentMethod: method, paidAt: new Date().toISOString()
  }).write();

  const updated = db.get('orders').find({ id: orderId }).value();
  addLog('success', `Payment: ${orderId} via ${method}`);
  notifyKiosk(kioskId, { type: 'payment_confirmed', orderId, method, order: updated });
  res.json({ success: true });
});

app.post('/api/payment/webhook', (req, res) => {
  const { orderId, status, method, transactionId } = req.body;
  if (status === 'success') {
    const o = db.get('orders').find({ id: orderId }).value();
    if (o) {
      db.get('orders').find({ id: orderId }).assign({
        status: 'paid', paymentMethod: method, transactionId,
        paidAt: new Date().toISOString()
      }).write();
      notifyKiosk(o.kioskId, { type: 'payment_confirmed', orderId, method });
      addLog('success', `Webhook payment: ${orderId}`);
    }
  }
  res.json({ received: true });
});

// ── PRINT ──
app.post('/api/print/status', (req, res) => {
  const { orderId, status } = req.body;
  db.get('orders').find({ id: orderId })
    .assign({ status, updatedAt: new Date().toISOString() }).write();
  addLog('info', `Print: ${orderId} → ${status}`);
  res.json({ success: true });
});

// ── LOGS ──
app.get('/api/logs', (req, res) => {
  const logs = db.get('logs').value().slice().reverse();
  res.json({ logs });
});

app.delete('/api/logs', (req, res) => {
  db.set('logs', []).write();
  res.json({ success: true });
});

// ── HEALTH ──
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: Math.floor(process.uptime()),
    sessions: Object.keys(sessions).length,
    orders: db.get('orders').value().length,
    kioskConnected: Object.keys(kioskClients).length > 0,
    connectedKiosks: Object.keys(kioskClients),
    time: new Date().toISOString()
  });
});

app.get('/api/localip', (req, res) => {
  const { networkInterfaces } = require('os');
  const nets = networkInterfaces();
  let ip = 'localhost';
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) { ip = net.address; break; }
    }
  }
  res.json({ ip, port: PORT, url: `http://${ip}:${PORT}` });
});

// ── START ──
server.listen(PORT, '0.0.0.0', () => {
  console.log('\n╔═══════════════════════════════════╗');
  console.log('║    PRINTDUAN SERVER v4 STARTED    ║');
  console.log('╠═══════════════════════════════════╣');
  console.log(`║  Port: ${PORT}                          ║`);
  console.log('╚═══════════════════════════════════╝\n');
  addLog('info', 'Server started v4');
});

module.exports = { app, server };
