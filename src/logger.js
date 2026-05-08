import chalk from 'chalk';
import CONFIG from './config.js';

// ============================================================
// Aviator Probe — Logger
// ============================================================

const LOG_LEVELS = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const currentLevel = LOG_LEVELS[CONFIG.LOG_LEVEL] ?? LOG_LEVELS.info;

function timestamp() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function shouldLog(level) {
  return LOG_LEVELS[level] >= currentLevel;
}

const logger = {
  debug(...args) {
    if (!shouldLog('debug')) return;
    console.log(chalk.gray(`[${timestamp()}] [DEBUG]`), ...args);
  },

  info(...args) {
    if (!shouldLog('info')) return;
    console.log(chalk.cyan(`[${timestamp()}] [INFO]`), ...args);
  },

  success(...args) {
    if (!shouldLog('info')) return;
    console.log(chalk.green(`[${timestamp()}] [✓]`), ...args);
  },

  warn(...args) {
    if (!shouldLog('warn')) return;
    console.log(chalk.yellow(`[${timestamp()}] [⚠]`), ...args);
  },

  error(...args) {
    if (!shouldLog('error')) return;
    console.log(chalk.red(`[${timestamp()}] [✗]`), ...args);
  },

  raw(...args) {
    console.log(...args);
  },

  divider(title) {
    if (!shouldLog('info')) return;
    const line = '='.repeat(60);
    if (title) {
      console.log(chalk.magenta(`\n${line}`));
      console.log(chalk.magenta(`  ${title}`));
      console.log(chalk.magenta(`${line}\n`));
    } else {
      console.log(chalk.gray(line));
    }
  },
};

export default logger;
