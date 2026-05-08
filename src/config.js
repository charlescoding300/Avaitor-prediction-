import path from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';

// ============================================================
// Aviator Probe — Configuration
// ============================================================

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CONFIG = {
  // === Server ===
  PORT: process.env.PORT || 3000,
  HOST: process.env.HOST || '0.0.0.0',

  // === Puppeteer / Browser ===
  PUPPETEER: {
    HEADLESS: process.env.HEADLESS !== 'false',
    SLOW_MO: parseInt(process.env.SLOW_MO || '20', 10),
    // On Termux, Chromium is usually at this path after `pkg install chromium`
    EXECUTABLE_PATH: process.env.PUPPETEER_EXECUTABLE_PATH || null,
    ARGS: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-web-security',
      '--disable-features=IsolateOrigins,site-per-process',
      '--window-size=1920,1080',
    ],
    VIEWPORT: { width: 1920, height: 1080 },
    USER_AGENT:
      'Mozilla/5.0 (Linux; Android 14; SM-S928B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.6367.105 Mobile Safari/537.36',
  },

  // === Target Site ===
  TARGET_URL: process.env.TARGET_URL || 'https://www.sportybet.com/ng/aviator',
  NAVIGATION_TIMEOUT: 30000,

  // === WebSocket Interception ===
  WS: {
    FILTER_PATTERNS: ['aviator', 'socket', 'ws', 'game'],
    DEBUG_RAW: process.env.DEBUG_WS === 'true',
  },

  // === Protobuf Decoding ===
  PROTOBUF: {
    DESCRIPTOR_PATH: path.join(__dirname, 'proto', 'aviator.proto'),
    FALLBACK_TO_JSON: true,
  },

  // === Crash Point Detection ===
  CRASH_DETECTION: {
    METHOD: 'protobuf',
    CONFIDENCE_THRESHOLD: 0.85,
    ROUND_COOLDOWN: 1500,
  },

  // === History / Storage ===
  STORAGE: {
    MAX_ROUNDS: process.env.MAX_ROUNDS || 500,
    PERSIST_PATH: path.join(__dirname, '..', 'data', 'rounds.json'),
    ENABLE_PERSIST: true,
  },

  // === Dashboard ===
  DASHBOARD: {
    UPDATE_INTERVAL: 200,
    RECENT_ROUNDS: 50,
  },

  // === Logging ===
  LOG_LEVEL: process.env.LOG_LEVEL || 'info',
  LOG_FILE: process.env.LOG_FILE || null,
};

export default CONFIG;
