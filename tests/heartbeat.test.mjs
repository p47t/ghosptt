import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import ts from 'typescript';

// Load the browser TypeScript module
const modules = new Map();
function moduleUrl(file) {
  file = resolve(file);
  if (modules.has(file)) return modules.get(file);
  let code = ts.transpileModule(readFileSync(file, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
  code = code.replace(/from ['"](.\/.+?)['"]/g, (_, path) =>
    `from '${moduleUrl(resolve(dirname(file), `${path}.ts`))}'`);
  const url = `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
  modules.set(file, url);
  return url;
}

const { PttConnectionClient, TELNET_IAC_NOP, HEARTBEAT_INTERVAL_MS } = await import(
  moduleUrl('src/ptt-client.ts')
);

// Mock browser WebSocket
class MockWebSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSING = 2;
  static CLOSED = 3;

  readyState = MockWebSocket.OPEN;
  binaryType = 'arraybuffer';
  sentData = [];
  listeners = new Map();

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }

  emit(type, event) {
    const list = this.listeners.get(type) || [];
    for (const fn of list) fn(event);
  }

  send(data) {
    this.sentData.push(data);
  }

  close() {
    this.readyState = MockWebSocket.CLOSED;
    this.emit('close', { code: 1000, reason: 'Normal Closure' });
  }
}

test('TELNET_IAC_NOP is 0xFF 0xF1', () => {
  assert.equal(TELNET_IAC_NOP[0], 0xff);
  assert.equal(TELNET_IAC_NOP[1], 0xf1);
  assert.equal(TELNET_IAC_NOP.length, 2);
  assert.equal(HEARTBEAT_INTERVAL_MS, 30_000);
});

test('PttConnectionClient sends periodic heartbeat when idle', async () => {
  let createdWs = null;
  globalThis.WebSocket = function (url, protocols) {
    createdWs = new MockWebSocket();
    return createdWs;
  };
  globalThis.WebSocket.OPEN = MockWebSocket.OPEN;
  globalThis.WebSocket.CONNECTING = MockWebSocket.CONNECTING;
  globalThis.window = {
    location: { protocol: 'https:', host: 'test.example.com' },
  };

  const client = new PttConnectionClient(() => 1, {
    onStatusChange() {},
    onTerminalText() {},
  });

  client.connect();
  assert.ok(createdWs);
  createdWs.emit('open', {});

  assert.equal(createdWs.sentData.length, 0);

  // Advance time past HEARTBEAT_INTERVAL_MS
  client.lastActivityTime = Date.now() - 35_000;

  // Trigger heartbeat check
  client.checkHeartbeat?.();

  // Or let private timer fire if accessible, or call sendHeartbeat
  assert.equal(createdWs.sentData.length, 1);
  assert.deepEqual(Array.from(createdWs.sentData[0]), [0xff, 0xf1]);

  // Activity should reset the timer
  client.sendRaw('a');
  assert.equal(createdWs.sentData.length, 2);
  assert.ok(Date.now() - client.lastActivityTime < 1000);

  client.disconnect();
  assert.equal(createdWs.readyState, MockWebSocket.CLOSED);
});
