// ============================================
// PRINTDUAN BACKEND SERVER v3
// ============================================
// Run: node server.js
// Kiosk:  http://localhost:3000/kiosk
// Admin:  http://localhost:3000/admin
// Mobile: http://{LOCAL_IP}:3000
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
const PORT = 3000;

// ============================================
// DATABASE SETUP (lowdb — saves to db.json)
// ============================================
const adapter = new FileSync(path.join(__dirname, 'db.json'));
const db = low(adapter);

db.defaults({
  orders: [],
  sessions: [],
  logs: []
}).write();

// ============================================
// FOLDERS SETUP
// ============================================
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const PUBLIC_DIR = path.join(__dirname, 'public');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR);
if (!fs.existsSync(PUBLIC_DIR)) fs.mkdirSync(PUBLIC_DIR);

// ============================================
// MIDDLEWARE
// ============================================
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(PUBLIC_DIR));
app.use('/uploads', express.static(UPLOADS_DIR));
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE');
  next();
});

// ============================================
// FILE UPLOAD CONFIG
// ============================================
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const unique = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const ext = path.extname(file.originalname);
    cb(null, unique + ext);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 },
});

// ============================================
// IN-MEMORY STATE (sessions + websockets)
// ============================================
let sessions = {};
let kioskClients = {};

function genRef() {
  return 'PD' + crypto.randomBytes(3).toString('hex').toUpperCase();
}

function addLog(type, msg) {
  db.get('logs').push({
    id: genRef(),
    type,
    msg,
    time: new Date().toISOString()
  }).write();
  // Keep only last 200 logs
  const logs = db.get('logs').value();
  if (logs.length > 200) {
    db.set('logs', logs.slice(-200)).write();
  }
}

// ============================================
// WEBSOCKET
// ============================================
wss.on('connection', (ws, req) => {
  const urlParams = new URLSearchParams(req.url.replace('/?', '').replace('/', ''));
  const kioskId = urlParams.get('kiosk') || 'kiosk-01';
  kioskClients[kioskId] = ws;
  addLog('info', `Kiosk connected: ${kioskId}`);
  console.log(`[WS] Kiosk connected: ${kioskId}`);

  ws.on('message', (msg) => {
    try {
      const data = JSON.parse(msg);
      handleKioskMessage(kioskId, data, ws);
    } catch (e) {}
  });

  ws.on('close', () => {
    delete kioskClients[kioskId];
    addLog('warn', `Kiosk disconnected: ${kioskId}`);
    console.log(`[WS] Kiosk disconnected: ${kioskId}`);
  });

  ws.send(JSON.stringify({ type: 'connected', kioskId, time: new Date().toISOString() }));
});

function handleKioskMessage(kioskId, data, ws) {
  switch (data.type) {
    case 'ping':
      ws.send(JSON.stringify({ type: 'pong' }));
      break;
    case 'print_ready':
      db.get('orders').find({ id: data.orderId }).assign({ status: 'printing', updatedAt: new Date().toISOString() }).write();
      addLog('info', `Printing started: ${data.orderId}`);
      break;
  }
}

function notifyKiosk(kioskId, message) {
  const ws = kioskClients[kioskId];
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
    return true;
  }
  return false;
}

// ============================================
// ROUTES — PAGES
// ============================================
app.get('/', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'mobile.html')));
app.get('/kiosk', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'kiosk.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'admin.html')));

// ============================================
// ROUTES — SESSION
// ============================================
app.post('/api/session/create', (req, res) => {
  const { kioskId = 'kiosk-01', type = 'login' } = req.body;
  const sessionId = genRef();
  sessions[sessionId] = {
    id: sessionId, kioskId, type,
    status: 'pending', files: [],
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() // 24 hours
  };
  console.log(`[SESSION] Created: ${sessionId}`);
  res.json({ success: true, sessionId });
});

app.get('/api/session/:id', (req, res) => {
  const session = sessions[req.params.id];
  if (!session) return res.status(404).json({ error: 'Session not found' });
  res.json(session);
});

// ============================================
// ROUTES — LOGIN
// ============================================
app.post('/api/login', (req, res) => {
  const { sessionId, kioskId = 'kiosk-01' } = req.body;
  const session = sessions[sessionId];
  if (!session) return res.status(404).json({ error: 'Invalid session' });
  session.status = 'authenticated';
  addLog('success', `Login: session ${sessionId}`);
  notifyKiosk(kioskId, { type: 'unlock', sessionId });
  res.json({ success: true });
});

// ============================================
// ROUTES — UPLOAD
// ============================================
app.post('/api/upload', upload.array('files', 10), (req, res) => {
  const { sessionId, kioskId = 'kiosk-01' } = req.body;
  if (!req.files || req.files.length === 0) return res.status(400).json({ error: 'No files' });

  const uploadedFiles = req.files.map(f => ({
    id: genRef(),
    name: f.originalname,
    filename: f.filename,
    size: f.size,
    path: `/uploads/${f.filename}`,
    uploadedAt: new Date().toISOString()
  }));

  if (sessionId && sessions[sessionId]) {
    sessions[sessionId].files.push(...uploadedFiles);
    sessions[sessionId].status = 'files_ready';
  }

  addLog('info', `Upload: ${uploadedFiles.length} file(s) — session ${sessionId}`);

  notifyKiosk(kioskId, {
    type: 'files_ready', sessionId,
    files: uploadedFiles.map(f => ({ name: f.name, size: f.size, path: f.path }))
  });

  res.json({ success: true, files: uploadedFiles });
});

app.get('/api/files/:sessionId', (req, res) => {
  const session = sessions[req.params.sessionId];
  if (!session) return res.status(404).json({ error: 'Session not found' });
  res.json({ files: session.files });
});

// ============================================
// ROUTES — ORDERS
// ============================================
app.post('/api/order/create', (req, res) => {
  const { sessionId, kioskId = 'kiosk-01', service, size, color, copies, amount } = req.body;
  const order = {
    id: genRef(),
    sessionId, kioskId,
    service: service || 'Document Print',
    size: size || 'A4',
    color: color || 'B&W',
    copies: parseInt(copies) || 1,
    amount: parseInt(amount) || 500,
    status: 'pending',
    paymentMethod: null,
    createdAt: new Date().toISOString()
  };

  db.get('orders').push(order).write();
  addLog('info', `Order created: ${order.id} — ${order.amount} LAK`);
  console.log(`[ORDER] ${order.id} — ${service} — ${order.amount} LAK`);
  res.json({ success: true, orderId: order.id, order });
});

app.get('/api/order/:id', (req, res) => {
  const order = db.get('orders').find({ id: req.params.id }).value();
  if (!order) return res.status(404).json({ error: 'Order not found' });
  res.json(order);
});

app.get('/api/orders', (req, res) => {
  const orders = db.get('orders').value().slice().reverse();
  res.json({ orders, total: orders.length });
});

// ============================================
// ROUTES — PAYMENT
// ============================================
app.post('/api/payment/confirm', (req, res) => {
  const { orderId, method, kioskId = 'kiosk-01' } = req.body;
  const order = db.get('orders').find({ id: orderId }).value();
  if (!order) return res.status(404).json({ error: 'Order not found' });

  db.get('orders').find({ id: orderId }).assign({
    status: 'paid',
    paymentMethod: method,
    paidAt: new Date().toISOString()
  }).write();

  const updated = db.get('orders').find({ id: orderId }).value();
  addLog('success', `Payment confirmed: ${orderId} via ${method}`);
  console.log(`[PAYMENT] ${orderId} paid via ${method}`);

  notifyKiosk(kioskId, { type: 'payment_confirmed', orderId, method, order: updated });
  res.json({ success: true });
});

app.post('/api/payment/webhook', (req, res) => {
  const { orderId, status, method, transactionId } = req.body;
  if (status === 'success') {
    const order = db.get('orders').find({ id: orderId }).value();
    if (order) {
      db.get('orders').find({ id: orderId }).assign({
        status: 'paid', paymentMethod: method,
        transactionId, paidAt: new Date().toISOString()
      }).write();
      notifyKiosk(order.kioskId, { type: 'payment_confirmed', orderId, method });
      addLog('success', `Webhook payment: ${orderId}`);
    }
  }
  res.json({ received: true });
});

// ============================================
// ROUTES — PRINT
// ============================================
app.post('/api/print/status', (req, res) => {
  const { orderId, status } = req.body;
  db.get('orders').find({ id: orderId }).assign({
    status, updatedAt: new Date().toISOString()
  }).write();
  addLog('info', `Print status: ${orderId} → ${status}`);
  res.json({ success: true });
});

// ============================================
// ROUTES — LOGS
// ============================================
app.get('/api/logs', (req, res) => {
  const logs = db.get('logs').value().slice().reverse();
  res.json({ logs });
});

app.delete('/api/logs', (req, res) => {
  db.set('logs', []).write();
  res.json({ success: true });
});

// ============================================
// ROUTES — HEALTH
// ============================================
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
  let localIP = 'localhost';
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) { localIP = net.address; break; }
    }
  }
  res.json({ ip: localIP, port: PORT, url: `http://${localIP}:${PORT}` });
});

// ============================================
// START SERVER
// ============================================
server.listen(PORT, '0.0.0.0', () => {
  const { networkInterfaces } = require('os');
  const nets = networkInterfaces();
  let localIP = 'localhost';
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) { localIP = net.address; break; }
    }
  }

  console.log('\n');
  console.log('╔════════════════════════════════════════╗');
  console.log('║      PRINTDUAN SERVER v3 STARTED       ║');
  console.log('║         (with database)                ║');
  console.log('╠════════════════════════════════════════╣');
  console.log(`║  Kiosk  → http://localhost:${PORT}/kiosk  ║`);
  console.log(`║  Admin  → http://localhost:${PORT}/admin  ║`);
  console.log(`║  Mobile → http://${localIP}:${PORT}     ║`);
  console.log('╚════════════════════════════════════════╝');
  console.log(`\n  💾 Database: db.json`);
  console.log(`  🖥️  Admin: http://localhost:${PORT}/admin\n`);

  addLog('info', 'Server started v3');
});

module.exports = { app, server };
