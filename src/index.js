#!/usr/bin/env node

import express from 'express';
import http from 'http';
import { Server as SocketIOServer } from 'socket.io';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import CONFIG from './config.js';
import logger from './logger.js';
import decoder from './protobuf-decoder.js';
import AviatorCDPProxy from './proxy.js';

// ============================================================
// Aviator Probe — Main Entry Point
// ============================================================

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---- Data Store ----
const rounds = [];        // { id, crashPoint, timestamp, time }
let currentState = 'disconnected';
let isRunning = false;
let restartTimer = null;

// ---- Express Setup ----
const app = express();
const server = http.createServer(app);

app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// ---- Socket.IO ----
const io = new SocketIOServer(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
});

// ---- Proxy Instance ----
const proxy = new AviatorCDPProxy();

// ============================================================
// Restore / Persist Rounds
// ============================================================

function persistRounds() {
  if (!CONFIG.STORAGE.ENABLE_PERSIST) return;
  try {
    const dir = path.dirname(CONFIG.STORAGE.PERSIST_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const data = rounds.slice(-CONFIG.STORAGE.MAX_ROUNDS);
    fs.writeFileSync(CONFIG.STORAGE.PERSIST_PATH, JSON.stringify(data, null, 2));
  } catch (err) {
    logger.warn(`Persist error: ${err.message}`);
  }
}

function loadPersistedRounds() {
  if (!CONFIG.STORAGE.ENABLE_PERSIST) return;
  try {
    if (fs.existsSync(CONFIG.STORAGE.PERSIST_PATH)) {
      const data = JSON.parse(fs.readFileSync(CONFIG.STORAGE.PERSIST_PATH, 'utf8'));
      rounds.push(...data.slice(-CONFIG.STORAGE.MAX_ROUNDS));
      logger.info(`Loaded ${data.length} persisted rounds`);
    }
  } catch (err) {
    logger.warn(`Load persist error: ${err.message}`);
  }
}

// ============================================================
// Crash Point Handler
// ============================================================

function onCrashPoint(crashPoint, roundData) {
  const round = {
    id: roundData.roundId || `round-${Date.now()}`,
    crashPoint: parseFloat(crashPoint.toFixed(2)),
    timestamp: roundData.timestamp,
    time: roundData.time || new Date().toISOString(),
  };

  rounds.push(round);

  // Keep max rounds
  if (rounds.length > CONFIG.STORAGE.MAX_ROUNDS) {
    rounds.splice(0, rounds.length - CONFIG.STORAGE.MAX_ROUNDS);
  }

  // Persist
  persistRounds();

  // Emit to dashboard
  io.emit('crash', round);
  io.emit('stats', getStats());
}

function onStateChange(state, decoded) {
  currentState = state;
  io.emit('state', { state, timestamp: Date.now() });

  if (state === 'waiting') {
    io.emit('waiting');
  }
}

function onRawFrame(frame) {
  if (CONFIG.WS.DEBUG_RAW) {
    logger.debug(`WS ${frame.isSent ? 'SENT' : 'RCV'}: ${frame.payload.substring(0, 80)}...`);
  }
}

// ============================================================
// Stats
// ============================================================

function getStats() {
  if (rounds.length === 0) {
    return {
      totalRounds: 0,
      avgCrash: 0,
      maxCrash: 0,
      minCrash: 0,
      medianCrash: 0,
      recentRounds: [],
    };
  }

  const recent = rounds.slice(-CONFIG.DASHBOARD.RECENT_ROUNDS);
  const crashPoints = recent.map((r) => r.crashPoint);
  crashPoints.sort((a, b) => a - b);

  const avg = crashPoints.reduce((s, v) => s + v, 0) / crashPoints.length;
  const mid = Math.floor(crashPoints.length / 2);

  return {
    totalRounds: rounds.length,
    avgCrash: parseFloat(avg.toFixed(2)),
    maxCrash: crashPoints[crashPoints.length - 1],
    minCrash: crashPoints[0],
    medianCrash: crashPoints.length % 2 === 0
      ? parseFloat(((crashPoints[mid - 1] + crashPoints[mid]) / 2).toFixed(2))
      : crashPoints[mid],
    recentRounds: recent.slice(-20).reverse(),
    currentState,
  };
}

// ============================================================
// REST API
// ============================================================

// Status
app.get('/api/status', (req, res) => {
  res.json({
    running: isRunning,
    connected: proxy.isConnected(),
    state: currentState,
    roundsCollected: rounds.length,
    uptime: process.uptime(),
    ...getStats(),
  });
});

// All rounds
app.get('/api/rounds', (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  res.json(rounds.slice(-limit).reverse());
});

// Single round
app.get('/api/rounds/:id', (req, res) => {
  const round = rounds.find((r) => r.id === req.params.id);
  if (round) {
    res.json(round);
  } else {
    res.status(404).json({ error: 'Round not found' });
  }
});

// Recent crash data (for dashboard polling)
app.get('/api/recent', (req, res) => {
  res.json({
    rounds: rounds.slice(-20).reverse(),
    stats: getStats(),
    state: currentState,
  });
});

// ============================================================
// Socket.IO Events
// ============================================================

io.on('connection', (socket) => {
  logger.info(`Dashboard client connected: ${socket.id}`);

  // Send initial data
  socket.emit('init', {
    rounds: rounds.slice(-CONFIG.DASHBOARD.RECENT_ROUNDS).reverse(),
    stats: getStats(),
    state: currentState,
    running: isRunning,
  });

  // Client requests test crash
  socket.on('test-crash', (data) => {
    const cp = data?.crashPoint || parseFloat((Math.random() * 10 + 1).toFixed(2));
    logger.info(`Test crash: ${cp}x`);
    onCrashPoint(cp, {
      roundId: `test-${Date.now()}`,
      timestamp: Date.now(),
      time: new Date().toISOString(),
    });
  });

  // Client requests start/stop
  socket.on('start', async () => {
    await startInterceptor();
  });

  socket.on('stop', async () => {
    await stopInterceptor();
  });

  socket.on('disconnect', () => {
    logger.debug(`Client disconnected: ${socket.id}`);
  });
});

// ============================================================
// Interceptor Control
// ============================================================

async function startInterceptor() {
  if (isRunning) {
    logger.warn('Interceptor is already running');
    return;
  }

  logger.divider('Starting Aviator Interceptor');
  isRunning = true;
  io.emit('running', true);

  try {
    await proxy.connect();

    // Wire up callbacks
    proxy.onCrashPoint = (cp, rd) => onCrashPoint(cp, rd);
    proxy.onStateChange = (s, d) => onStateChange(s, d);
    proxy.onRawFrame = (f) => onRawFrame(f);

    currentState = 'connected';
    io.emit('state', { state: 'connected', timestamp: Date.now() });
    logger.success('Interceptor running — monitoring Aviator game data');

  } catch (err) {
    logger.error(`Failed to start interceptor: ${err.message}`);
    isRunning = false;
    currentState = 'error';
    io.emit('state', { state: 'error', error: err.message });
    io.emit('running', false);
  }
}

async function stopInterceptor() {
  if (!isRunning) return;

  logger.info('Stopping interceptor...');
  isRunning = false;
  currentState = 'disconnected';

  await proxy.disconnect();
  io.emit('running', false);
  io.emit('state', { state: 'disconnected', timestamp: Date.now() });
  logger.success('Interceptor stopped');
}

// ============================================================
// Graceful Shutdown
// ============================================================

async function shutdown(signal) {
  logger.divider(`Shutdown (${signal})`);
  
  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }

  await stopInterceptor();
  persistRounds();

  io.close(() => {
    logger.info('Socket.IO closed');
  });

  server.close(() => {
    logger.info('HTTP server closed');
    process.exit(0);
  });

  // Force exit after 5s
  setTimeout(() => {
    logger.warn('Forced shutdown');
    process.exit(1);
  }, 5000);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (err) => {
  logger.error(`Uncaught exception: ${err.message}`);
  logger.error(err.stack);
});
process.on('unhandledRejection', (reason) => {
  logger.warn(`Unhandled rejection: ${reason}`);
});

// ============================================================
// Serve Frontend
// ============================================================

// SPA fallback: serve index.html for any unknown route
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// ============================================================
// Boot
// ============================================================

async function main() {
  logger.divider('Aviator Probe v2.0');
  logger.info(`PID: ${process.pid}`);
  logger.info(`Node: ${process.version}`);
  logger.info(`Platform: ${process.platform} ${process.arch}`);

  // Load persisted data
  loadPersistedRounds();

  // Initialize protobuf decoder
  await decoder.initialize();

  // Start HTTP server
  server.listen(CONFIG.PORT, CONFIG.HOST, () => {
    logger.success(`Dashboard: http://${CONFIG.HOST}:${CONFIG.PORT}`);
    logger.info(`API: http://${CONFIG.HOST}:${CONFIG.PORT}/api/status`);
    logger.divider();

    // Auto-start interceptor if AUTO_START is set
    if (process.env.AUTO_START === 'true') {
      startInterceptor().catch((err) => {
        logger.error(`Auto-start failed: ${err.message}`);
      });
    } else {
      logger.info('Run: curl http://localhost:' + CONFIG.PORT + '/api/status');
      logger.info('Or connect via browser to the dashboard');
    }
  });
}

main();
