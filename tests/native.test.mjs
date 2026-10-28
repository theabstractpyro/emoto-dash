import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FardriverNative } from '../js/sources/fardriver-native.js';
import { encodeLegacyFrame } from '../js/protocol/fardriver.js';

const SERVICE = '0000ffe0-0000-1000-8000-00805f9b34fb';
const CHAR = '0000ffec-0000-1000-8000-00805f9b34fb';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(cond, ms = 3000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('condition not met in time');
    await wait(5);
  }
}

// Stand-in for the Capacitor BluetoothLe plugin, with a controller whose Bluetooth address
// changes at every power-up (as the real one does) and a BMS advertising nearby.
class FakePlugin {
  constructor() {
    this.listeners = new Map();
    this.on = true;
    this.boot = 1;
    this.scanning = false;
    this.connected = null;
    this.connectCalls = [];
  }

  addr() {
    return `C0:0D:64:3A:00:${String(this.boot).padStart(2, '0')}`;
  }

  async initialize() {}
  async isEnabled() { return { value: true }; }
  async isLocationEnabled() { return { value: true }; }

  async addListener(event, cb) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event).add(cb);
    return { remove: async () => this.listeners.get(event)?.delete(cb) };
  }

  emit(event, data) {
    for (const cb of this.listeners.get(event) ?? []) cb(data);
  }

  advertise() {
    setTimeout(() => {
      if (!this.scanning) return;
      this.emit('onScanResult', { device: { deviceId: 'E0:00:00:00:00:01', name: 'ANT-BLE20PHUB' }, rssi: -70 });
      if (this.on) this.emit('onScanResult', { device: { deviceId: this.addr(), name: 'YuanQuFOC568' }, localName: 'YuanQuFOC568', rssi: -55 });
    }, 5);
  }

  async requestLEScan() {
    this.scanning = true;
    this.advertise();
  }

  async stopLEScan() { this.scanning = false; }

  async connect({ deviceId }) {
    this.connectCalls.push(deviceId);
    await wait(2);
    if (!this.on || deviceId !== this.addr()) throw new Error('Connection timeout');
    this.connected = deviceId;
  }

  async startNotifications() {}
  async writeWithoutResponse() {}

  async disconnect({ deviceId }) {
    if (this.connected !== deviceId) return;
    this.connected = null;
    this.emit(`disconnected|${deviceId}`);
  }

  sendFrame() {
    const f = encodeLegacyFrame(10, (b) => (b[10] = 70));
    const value = Array.from(f, (x) => x.toString(16).padStart(2, '0')).join(' ');
    this.emit(`notification|${this.connected}|${SERVICE}|${CHAR}`, { value });
  }

  keyOff() {
    this.on = false;
    const id = this.connected;
    this.connected = null;
    this.emit(`disconnected|${id}`);
  }

  keyOn() {
    this.on = true;
    this.boot++; // new random address at every power-up
    if (this.scanning) this.advertise();
  }
}

const settings = { keepAlive: false, controllerName: '' };
const timing = { retryMs: 10, watchdogMs: 400, connectTimeoutMs: 100 };

test('native source reconnects by name after key-off/on despite the new address', async () => {
  const plugin = new FakePlugin();
  const ctrl = new FardriverNative(settings, { plugin, timing });
  const frames = [];
  ctrl.addEventListener('frame', (e) => frames.push(e.detail));

  await ctrl.start();
  await until(() => ctrl.status === 'connected');
  assert.equal(plugin.connected, 'C0:0D:64:3A:00:01');
  plugin.sendFrame();
  assert.equal(frames.length, 1);

  plugin.keyOff();
  await until(() => ctrl.status === 'reconnecting');
  await wait(50);
  plugin.keyOn();
  await until(() => ctrl.status === 'connected');
  assert.equal(plugin.connected, 'C0:0D:64:3A:00:02', 'connected to the new address');
  plugin.sendFrame();
  assert.equal(frames.length, 2, 'one notification listener per link, no duplicates');
  assert.ok(!plugin.connectCalls.includes('E0:00:00:00:00:01'), 'never connects to the BMS');
  ctrl.disconnect();
  assert.equal(ctrl.status, 'disconnected');
});

test('a custom name prefix limits which device is used', async () => {
  const plugin = new FakePlugin();
  const ctrl = new FardriverNative({ ...settings, controllerName: 'MyBike' }, { plugin, timing });
  await ctrl.start();
  await wait(100);
  assert.equal(ctrl.status, 'connecting');
  assert.deepEqual(plugin.connectCalls, []);
  ctrl.disconnect();
});

test('watchdog restarts a silent link and finds the controller again', async () => {
  const plugin = new FakePlugin();
  const ctrl = new FardriverNative(settings, { plugin, timing });
  await ctrl.start();
  await until(() => ctrl.status === 'connected');
  // No frames arrive: the watchdog should drop and re-establish the link.
  await until(() => /No data/.test(ctrl.lastError), 2000);
  await until(() => ctrl.status === 'connected', 2000);
  ctrl.disconnect();
});
