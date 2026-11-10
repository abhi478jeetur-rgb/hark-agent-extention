'use strict';
// Minimal RFC 6455 WebSocket server on top of node:http, with no dependencies.
// Supports text/binary frames, fragmentation, ping/pong, close, and 64-bit lengths. Server frames are never masked.
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_MESSAGE = 64 * 1024 * 1024; // 64 MB: screenshots of large pages fit.

function acceptKey(key) {
  return crypto
    .createHash('sha1')
    .update(key + GUID)
    .digest('base64');
}

function encodeFrame(opcode, payload) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x80 | opcode;
  return Buffer.concat([header, payload]);
}

class WsConnection extends EventEmitter {
  constructor(socket, request) {
    super();
    this.socket = socket;
    this.request = request;
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    this.fragmentOpcode = 0;
    this.closed = false;
    socket.on('data', chunk => this._onData(chunk));
    socket.on('close', () => this._finish(1006, 'socket closed'));
    socket.on('error', err => {
      this.emit('error', err);
      this._finish(1006, err.message);
    });
  }

  _finish(code, reason) {
    if (this.closed) return;
    this.closed = true;
    this.emit('close', code, reason);
  }

  _onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      if (this.buffer.length < 2) return;
      const b0 = this.buffer[0];
      const b1 = this.buffer[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (this.buffer.length < 4) return;
        len = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (this.buffer.length < 10) return;
        const big = this.buffer.readBigUInt64BE(2);
        if (big > BigInt(MAX_MESSAGE)) return this.close(1009, 'message too big');
        len = Number(big);
        offset = 10;
      }
      if (!masked) return this.close(1002, 'client frames must be masked');
      if (len > MAX_MESSAGE) return this.close(1009, 'message too big');
      if (this.buffer.length < offset + 4 + len) return;
      const mask = this.buffer.subarray(offset, offset + 4);
      const payload = Buffer.from(this.buffer.subarray(offset + 4, offset + 4 + len));
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      this.buffer = this.buffer.subarray(offset + 4 + len);
      this._onFrame(fin, opcode, payload);
      if (this.closed) return;
    }
  }

  _onFrame(fin, opcode, payload) {
    if (opcode === 0x8) {
      const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
      this.close(code === 1005 ? 1000 : code, '');
      return;
    }
    if (opcode === 0x9) return this._send(0xa, payload);
    if (opcode === 0xa) return this.emit('pong', payload);
    if (opcode === 0x0) {
      this.fragments.push(payload);
    } else {
      this.fragments = [payload];
      this.fragmentOpcode = opcode;
    }
    const total = this.fragments.reduce((n, f) => n + f.length, 0);
    if (total > MAX_MESSAGE) return this.close(1009, 'message too big');
    if (!fin) return;
    const data = Buffer.concat(this.fragments);
    this.fragments = [];
    this.emit('message', this.fragmentOpcode === 0x1 ? data.toString('utf8') : data, this.fragmentOpcode === 0x2);
  }

  _send(opcode, payload) {
    if (this.closed || this.socket.destroyed) return false;
    this.socket.write(encodeFrame(opcode, payload));
    return true;
  }

  send(data) {
    return typeof data === 'string' ? this._send(0x1, Buffer.from(data, 'utf8')) : this._send(0x2, data);
  }

  ping(data = Buffer.alloc(0)) {
    return this._send(0x9, data);
  }

  close(code = 1000, reason = '') {
    if (this.closed) return;
    const r = Buffer.from(String(reason).slice(0, 120), 'utf8');
    const p = Buffer.alloc(2 + r.length);
    p.writeUInt16BE(code, 0);
    r.copy(p, 2);
    try {
      this._send(0x8, p);
      this.socket.end();
    } catch {
      /* ignore */
    }
    setTimeout(() => this.socket.destroy(), 1000).unref();
    this._finish(code, reason);
  }
}

/**
 * Upgrades an HTTP request to a WebSocket. Returns the connection, or null after answering 400.
 * `verifyOrigin(origin)` may reject the request.
 */
function upgrade(request, socket, verifyOrigin) {
  const key = request.headers['sec-websocket-key'];
  const isWs = String(request.headers.upgrade || '').toLowerCase() === 'websocket';
  if (!isWs || !key || (verifyOrigin && !verifyOrigin(request.headers.origin))) {
    socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return null;
  }
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`,
  );
  socket.setNoDelay(true);
  return new WsConnection(socket, request);
}

/** A tiny client, used by the tests to play the extension. */
function connectClient(url) {
  const http = require('node:http');
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const key = crypto.randomBytes(16).toString('base64');
    const req = http.request({
      host: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': '13' },
    });
    req.on('upgrade', (res, socket) => {
      if (res.headers['sec-websocket-accept'] !== acceptKey(key)) return reject(new Error('bad accept'));
      const conn = new EventEmitter();
      let buffer = Buffer.alloc(0);
      socket.on('data', chunk => {
        buffer = Buffer.concat([buffer, chunk]);
        for (;;) {
          if (buffer.length < 2) return;
          const opcode = buffer[0] & 0x0f;
          let len = buffer[1] & 0x7f;
          let off = 2;
          if (len === 126) {
            if (buffer.length < 4) return;
            len = buffer.readUInt16BE(2);
            off = 4;
          } else if (len === 127) {
            if (buffer.length < 10) return;
            len = Number(buffer.readBigUInt64BE(2));
            off = 10;
          }
          if (buffer.length < off + len) return;
          const payload = buffer.subarray(off, off + len);
          buffer = buffer.subarray(off + len);
          if (opcode === 0x1) conn.emit('message', payload.toString('utf8'));
          else if (opcode === 0x8) {
            conn.emit('close', payload.length >= 2 ? payload.readUInt16BE(0) : 1005);
            socket.end();
          }
        }
      });
      socket.on('close', () => conn.emit('close', 1006));
      conn.send = text => {
        const payload = Buffer.from(text, 'utf8');
        const mask = crypto.randomBytes(4);
        const masked = Buffer.from(payload);
        for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i & 3];
        const frame = encodeFrame(0x1, masked);
        // Set the mask bit and insert the key after the length.
        const headLen = frame.length - masked.length;
        const head = Buffer.from(frame.subarray(0, headLen));
        head[1] |= 0x80;
        socket.write(Buffer.concat([head, mask, masked]));
      };
      conn.close = () => socket.end();
      resolve(conn);
    });
    req.on('error', reject);
    req.end();
  });
}

module.exports = { upgrade, WsConnection, connectClient, acceptKey };
