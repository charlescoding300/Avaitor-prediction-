import puppeteer from 'puppeteer';
import logger from './logger.js';
import CONFIG from './config.js';
import decoder from './protobuf-decoder.js';

// ============================================================
// Aviator Probe — CDP Proxy / WebSocket Interceptor
// ============================================================

class AviatorCDPProxy {
  constructor() {
    this.browser = null;
    this.page = null;
    this.session = null;
    this.connected = false;
    this.onCrashPoint = null; // callback(crashPoint, roundData)
    this.onRawFrame = null;   // callback(rawPayload)
    this.onStateChange = null; // callback(state)
    this.roundStartTime = null;
    this.currentRoundId = null;
    this.crashCooldown = false;
    this.consecutiveErrors = 0;
    this.maxErrors = 10;
  }

  /**
   * Launch browser and navigate to Aviator game
   */
  async connect() {
    logger.divider('Launching Browser');

    try {
      const launchOpts = {
        headless: CONFIG.PUPPETEER.HEADLESS ? 'new' : false,
        args: CONFIG.PUPPETEER.ARGS,
        defaultViewport: CONFIG.PUPPETEER.VIEWPORT,
        slowMo: CONFIG.PUPPETEER.SLOW_MO,
      };

      // Set custom executable path if provided (for Termux)
      if (CONFIG.PUPPETEER.EXECUTABLE_PATH) {
        launchOpts.executablePath = CONFIG.PUPPETEER.EXECUTABLE_PATH;
        logger.info(`Using custom browser: ${CONFIG.PUPPETEER.EXECUTABLE_PATH}`);
      }

      // Try launching
      try {
        this.browser = await puppeteer.launch(launchOpts);
      } catch (launchErr) {
        // Fallback: try finding chromium via `which`
        logger.warn(`Primary launch failed: ${launchErr.message}`);
        logger.info('Trying to find chromium via which...');
        
        const { execSync } = await import('child_process');
        try {
          const chromiumPath = execSync('which chromium-browser chromium google-chrome google-chrome-stable', { encoding: 'utf8' }).split('\n')[0].trim();
          if (chromiumPath) {
            logger.info(`Found chromium at: ${chromiumPath}`);
            launchOpts.executablePath = chromiumPath;
            this.browser = await puppeteer.launch(launchOpts);
          } else {
            throw new Error('No browser found');
          }
        } catch (whichErr) {
          logger.error('Could not find any Chromium/Chrome installation');
          logger.error('On Termux: pkg install chromium');
          logger.error('Then set PUPPETEER_EXECUTABLE_PATH=/data/data/com.termux/files/usr/bin/chromium');
          throw new Error('No browser executable found');
        }
      }

      logger.success(`Browser launched (PID: ${this.browser.process().pid})`);

      // Create new page
      this.page = await this.browser.newPage();
      await this.page.setUserAgent(CONFIG.PUPPETEER.USER_AGENT);

      // Create CDP session for WebSocket interception
      this.session = await this.page.target().createCDPSession();
      await this.session.send('Network.enable');

      // Intercept WebSocket frames
      this.session.on('Network.webSocketCreated', (params) => {
        logger.debug(`WebSocket created: ${params.url}`);
      });

      this.session.on('Network.webSocketFrameReceived', (params) => {
        this._handleWSFrame(params.response.payloadData, false);
      });

      this.session.on('Network.webSocketFrameSent', (params) => {
        this._handleWSFrame(params.response.payloadData, true);
      });

      logger.success('CDP session established — intercepting WebSocket traffic');

      // Navigate to game
      logger.info(`Navigating to ${CONFIG.TARGET_URL}`);
      await this.page.goto(CONFIG.TARGET_URL, {
        waitUntil: 'networkidle2',
        timeout: CONFIG.NAVIGATION_TIMEOUT,
      });

      logger.success('Page loaded — monitoring game data...');
      this.connected = true;
      this.consecutiveErrors = 0;

      // Handle console events from the page for additional data
      this.page.on('console', (msg) => {
        if (msg.text().includes('crash') || msg.text().includes('multiplier')) {
          logger.debug(`[PAGE] ${msg.text()}`);
        }
      });

      // Handle page errors
      this.page.on('error', (err) => {
        logger.error(`Page error: ${err.message}`);
      });

    } catch (err) {
      logger.error(`Connection failed: ${err.message}`);
      this.consecutiveErrors++;
      throw err;
    }
  }

  /**
   * Handle intercepted WebSocket frame
   */
  _handleWSFrame(payloadData, isSent) {
    try {
      // Check if payload looks like base64 binary (protobuf)
      const isBase64 = /^[A-Za-z0-9+/]+=*$/.test(payloadData) && payloadData.length > 20;
      
      if (isBase64 || Buffer.isBuffer(payloadData)) {
        // Try to decode as protobuf
        const decoded = decoder.decode(payloadData);
        
        if (decoded) {
          // Check for crash point
          if (decoder.isCrashPayload(decoded)) {
            const crashPoint = decoder.extractCrashPoint(decoded);
            
            if (crashPoint && !this.crashCooldown) {
              this.crashCooldown = true;
              
              const roundData = {
                crashPoint,
                roundId: decoded.roundId || this.currentRoundId || `round-${Date.now()}`,
                timestamp: Date.now(),
                time: new Date().toISOString(),
                decoded,
              };

              logger.success(`🎯 CRASH POINT: ${crashPoint.toFixed(2)}x`);
              
              if (this.onCrashPoint) {
                this.onCrashPoint(crashPoint, roundData);
              }

              // Reset cooldown after delay
              setTimeout(() => {
                this.crashCooldown = false;
              }, CONFIG.CRASH_DETECTION.ROUND_COOLDOWN);
            }
          }

          // Check for state changes
          if (decoded.state) {
            if (decoded.state === 'flying') {
              this.roundStartTime = Date.now();
              this.currentRoundId = decoded.roundId;
              logger.info(`🚀 Round ${this.currentRoundId} started...`);
              if (this.onStateChange) this.onStateChange('flying', decoded);
            } else if (decoded.state === 'waiting') {
              if (this.onStateChange) this.onStateChange('waiting', decoded);
            }
          }
        }
      }

      // Forward raw frame to callback
      if (this.onRawFrame) {
        this.onRawFrame({ payload: payloadData, isSent, timestamp: Date.now() });
      }

      this.consecutiveErrors = 0;
    } catch (err) {
      this.consecutiveErrors++;
      if (this.consecutiveErrors > this.maxErrors) {
        logger.error(`Too many errors processing frames (${this.consecutiveErrors})`);
      }
    }
  }

  /**
   * Check if browser is still connected
   */
  isConnected() {
    return this.connected && this.browser && this.browser.isConnected();
  }

  /**
   * Disconnect and clean up
   */
  async disconnect() {
    logger.info('Disconnecting...');
    this.connected = false;
    
    if (this.session) {
      try {
        await this.session.detach();
      } catch (e) { /* ignore */ }
    }
    
    if (this.browser) {
      try {
        await this.browser.close();
        logger.success('Browser closed');
      } catch (e) {
        logger.warn(`Browser close error: ${e.message}`);
      }
    }
  }

  /**
   * Reconnect (call after disconnect)
   */
  async reconnect() {
    logger.info('Reconnecting...');
    await this.disconnect();
    await this.connect();
  }
}

export default AviatorCDPProxy;
