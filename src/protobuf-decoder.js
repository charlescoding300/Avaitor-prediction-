import protobuf from 'protobufjs';
import logger from './logger.js';
import CONFIG from './config.js';

// ============================================================
// Aviator Probe — Protobuf Decoder
// ============================================================

/**
 * Heuristic protobuf decoder for Aviator game binary messages.
 * 
 * Aviator uses protobuf-encoded WebSocket frames. The exact .proto
 * schema is proprietary to Spribe/SportyBet, but we can decode
 * common field patterns through heuristic analysis.
 * 
 * Known field mappings (based on reverse engineering):
 *   field 1: roundId (uint64)
 *   field 2: crashPoint / multiplier (float64, e.g. 2.35x)
 *   field 3: timestamp / epoch ms (uint64)
 *   field 4: round state (enum: 0=waiting, 1=flying, 2=crashed)
 *   field 5: hash / seed (bytes)
 *   field 6: player count? (uint32)
 *   field 7: total bet? (float64)
 */

class ProtobufDecoder {
  constructor() {
    this.root = null;
    this.AviatorMessage = null;
    this.initialized = false;
    this.schemaPath = CONFIG.PROTOBUF.DESCRIPTOR_PATH;
  }

  /**
   * Initialize the decoder — try to load .proto file, fall back to heuristic
   */
  async initialize() {
    // Try loading the .proto file if it exists
    try {
      const fs = await import('fs');
      if (fs.existsSync(this.schemaPath)) {
        this.root = await protobuf.load(this.schemaPath);
        this.AviatorMessage = this.root.lookupType('AviatorMessage');
        this.initialized = true;
        logger.success(`Loaded protobuf schema from ${this.schemaPath}`);
        return;
      }
    } catch (err) {
      logger.warn(`Could not load .proto schema: ${err.message}`);
    }

    logger.info('Using heuristic protobuf decoder (no .proto schema)');
    this.initialized = true;
  }

  /**
   * Decode a binary WebSocket frame (Buffer or base64 string)
   * @param {Buffer|string} data - Raw binary data or base64 string
   * @returns {Object|null} Decoded message, or null on failure
   */
  decode(data) {
    if (!this.initialized) {
      logger.warn('Decoder not initialized');
      return null;
    }

    try {
      let buffer;
      if (typeof data === 'string') {
        // Base64 encoded binary
        buffer = Buffer.from(data, 'base64');
      } else if (Buffer.isBuffer(data)) {
        buffer = data;
      } else if (data instanceof ArrayBuffer) {
        buffer = Buffer.from(data);
      } else {
        logger.debug(`Unknown data type: ${typeof data}`);
        return null;
      }

      // Try protobufjs decode if schema is loaded
      if (this.root && this.AviatorMessage) {
        try {
          const decoded = this.AviatorMessage.decode(buffer);
          const plain = this.AviatorMessage.toObject(decoded, {
            longs: String,
            enums: String,
            bytes: String,
            defaults: true,
          });
          return { method: 'protobuf', data: plain, raw: buffer };
        } catch (pfErr) {
          logger.debug(`Protobuf decode failed: ${pfErr.message}`);
        }
      }

      // Heuristic fallback: parse known field patterns
      return this._heuristicDecode(buffer);
    } catch (err) {
      logger.debug(`Decode error: ${err.message}`);
      return null;
    }
  }

  /**
   * Heuristic binary parser for Aviator protobuf wire format
   * 
   * Parses varint-prefixed field tags and known data types
   */
  _heuristicDecode(buffer) {
    const result = { method: 'heuristic', fields: {} };
    let offset = 0;

    try {
      while (offset < buffer.length) {
        // Read varint tag (field_number << 3 | wire_type)
        const tag = this._readVarint(buffer, offset);
        if (tag === null) break;
        offset = tag.newOffset;

        const fieldNumber = tag.value >> 3;
        const wireType = tag.value & 0x07;

        switch (wireType) {
          case 0: { // Varint
            const val = this._readVarint(buffer, offset);
            if (val === null) break;
            offset = val.newOffset;
            result.fields[fieldNumber] = val.value;
            break;
          }
          case 1: { // 64-bit (fixed 8 bytes)
            if (offset + 8 > buffer.length) break;
            const doubleVal = buffer.readDoubleLE(offset);
            result.fields[fieldNumber] = parseFloat(doubleVal.toFixed(4));
            offset += 8;
            break;
          }
          case 2: { // Length-delimited
            const len = this._readVarint(buffer, offset);
            if (len === null) break;
            offset = len.newOffset;
            if (offset + len.value > buffer.length) break;
            const strData = buffer.slice(offset, offset + len.value);
            result.fields[fieldNumber] = strData.toString('hex');
            offset += len.value;
            break;
          }
          case 5: { // 32-bit (fixed 4 bytes)
            if (offset + 4 > buffer.length) break;
            result.fields[fieldNumber] = buffer.readFloatLE(offset);
            offset += 4;
            break;
          }
          default:
            offset += 1; // Skip unknown wire types
        }
      }
    } catch (err) {
      logger.debug(`Heuristic decode error: ${err.message}`);
      return null;
    }

    // Interpret known fields
    return this._interpretFields(result);
  }

  /**
   * Interpret heuristic fields into Aviator game state
   */
  _interpretFields(result) {
    const fields = result.fields;
    const interpreted = {
      method: 'heuristic',
      raw: result,
    };

    // Field 2 is typically the crash point multiplier (float64)
    if (fields[2] !== undefined && typeof fields[2] === 'number') {
      interpreted.crashPoint = fields[2];
    }

    // Field 1 is typically roundId (uint64 or string)
    if (fields[1] !== undefined) {
      interpreted.roundId = String(fields[1]);
    }

    // Field 4 is typically round state (0=waiting, 1=flying, 2=crashed)
    if (fields[4] !== undefined) {
      interpreted.state = ['waiting', 'flying', 'crashed'][fields[4]] || 'unknown';
    }

    // Field 3 is typically timestamp
    if (fields[3] !== undefined) {
      interpreted.timestamp = Number(fields[3]);
      interpreted.time = new Date(Number(fields[3])).toISOString();
    }

    return interpreted;
  }

  /**
   * Read a protobuf varint from buffer at given offset
   */
  _readVarint(buffer, offset) {
    let value = 0;
    let shift = 0;
    let pos = offset;

    while (pos < buffer.length) {
      const byte = buffer[pos];
      value |= (byte & 0x7f) << shift;
      shift += 7;
      pos++;

      if (!(byte & 0x80)) {
        return { value: value >>> 0, newOffset: pos };
      }
    }

    return null; // incomplete varint
  }

  /**
   * Check if data looks like a crash point payload
   */
  isCrashPayload(decoded) {
    if (!decoded) return false;

    // Protobuf decode: check fields
    if (decoded.method === 'protobuf' && decoded.data) {
      const d = decoded.data;
      return (
        (d.crashPoint !== undefined && d.crashPoint > 1.0) ||
        (d.state === 'crashed') ||
        (d.multiplier !== undefined && d.multiplier > 1.0)
      );
    }

    // Heuristic decode: check interpreted fields
    if (decoded.crashPoint && decoded.crashPoint > 1.0) {
      return true;
    }

    return false;
  }

  /**
   * Extract crash point from decoded payload
   */
  extractCrashPoint(decoded) {
    if (!decoded) return null;

    if (decoded.method === 'protobuf' && decoded.data) {
      return decoded.data.crashPoint || decoded.data.multiplier || null;
    }

    if (decoded.crashPoint) {
      return decoded.crashPoint;
    }

    return null;
  }
}

// Singleton
const decoder = new ProtobufDecoder();
export default decoder;
