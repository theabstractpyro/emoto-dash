import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FardriverBle, chooserFilters } from '../js/sources/fardriver-ble.js';
import { encodeLegacyFrame } from '../js/protocol/fardriver.js';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(cond, ms = 3000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('condition not met in time');
    await wait(5);
  }
}

// Minimal stand-in for a Web Bluetooth device wired to a Fardriver controller.
class FakeController extends EventTarget {
  constructor() {
    super();
    this.id = 'dev-1';
    this.name = 'YuanQuFOC568';
    this.powered = true;
    this.hangConnects = false;
    this.connectCalls = 0;
    this.writes = [];
    const ch = new EventTarget();
    ch.startNotifications = async () => ch;
    ch.writeValueWithoutResponse = async (v) => this.writes.push(v);
    this.ch = ch;
    const server = { getPrimaryService: async () => ({ getCharacteristic: async () => ch }) };
    this.gatt = {
      connected: false,
      connect: () => {
        this.connectCalls++;
        if (this.hangConnects) return new Promise(() => {}); // Android sometimes never settles
        return wait(2).then(() => {
          if (!this.powered) throw new Error('NetworkError: Connection failed');
          this.gatt.connected = true;
          return server;
        });
      },
      disconnect: () => {
        if (!this.gatt.connected) return;
        this.gatt.connected = false;
        queueMicrotask(() => this.dispatchEvent(new Event('gattserverdisconnected')));
      },
    };
  }

  sendFrame() {
    const f = encodeLegacyFrame(10, (b) => (b[10] = 65));
    this.ch.value = new DataView(f.buffer);
    this.ch.dispatchEvent(new Event('characteristicvaluechanged'));
  }

  keyOff() {
    this.powered = false;
    this.gatt.disconnect();
  }
}

const settings = { autoReconnect: true, keepAlive: false };
const fast = { retryMinMs: 10, retryMaxMs: 40, connectTimeoutMs: 60, stepTimeoutMs: 60, watchdogMs: 150 };

test('reconnects by itself when the controller powers back on', async () => {
  const dev = new FakeController();
  const ble = new FardriverBle(settings, fast);
  const frames = [];
  ble.addEventListener('frame', (e) => frames.push(e.detail));
  await ble.attach(dev);
  assert.equal(ble.status, 'connected');
  dev.sendFrame();
  assert.equal(frames.length, 1);

  dev.keyOff();
  await until(() => ble.status === 'reconnecting');
  const callsWhileOff = dev.connectCalls;
  await wait(150);
  assert.ok(dev.connectCalls > callsWhileOff + 2, 'keeps retrying while powered off');

  dev.powered = true; // key on
  await until(() => ble.status === 'connected');
  dev.sendFrame();
  assert.equal(frames.length, 2, 'notifications flow again, without duplicate listeners');
  ble.disconnect();
});

test('a connect attempt that never settles is timed out and retried', async () => {
  const dev = new FakeController();
  dev.powered = false;
  dev.hangConnects = true;
  const ble = new FardriverBle(settings, fast);
  await assert.rejects(ble.attach(dev), /timed out/);
  assert.equal(ble.status, 'reconnecting');
  dev.hangConnects = false;
  dev.powered = true;
  await until(() => ble.status === 'connected');
  ble.disconnect();
});

test('watchdog drops a link that stops delivering data', async () => {
  const dev = new FakeController();
  const ble = new FardriverBle(settings, fast);
  await ble.attach(dev);
  // Controller lost power, but the phone never reported a disconnect.
  dev.powered = false;
  await until(() => ble.status === 'reconnecting', 1000);
  assert.match(ble.lastError, /No data/);
  dev.powered = true;
  await until(() => ble.status === 'connected');
  ble.disconnect();
  assert.equal(ble.status, 'disconnected');
});

test('chooser filters find Fardriver names unless a custom prefix is set', () => {
  const auto = chooserFilters('');
  assert.ok(auto.some((f) => f.namePrefix && 'YuanQuFOC568'.startsWith(f.namePrefix)));
  assert.ok(auto.some((f) => f.services?.includes(0xffe0)));
  assert.deepEqual(chooserFilters(' MyBike '), [{ namePrefix: 'MyBike' }]);
});
