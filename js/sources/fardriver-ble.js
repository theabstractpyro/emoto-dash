// Web Bluetooth link to the Fardriver controller (service FFE0, characteristic FFEC).
//
// Source interface shared with DemoSource and future sources (e.g. a BMS):
//   EventTarget emitting
//     'status' -> detail: 'disconnected' | 'connecting' | 'connected' | 'reconnecting'
//     'frame'  -> detail: Uint8Array(16), an already-validated controller frame
//
// Reconnection: once a controller has been picked, the link keeps trying until the user
// disconnects. Turning the key off cuts the controller's power, so the link drops; when it
// powers back up the app reconnects by itself. Three mechanisms cover the gaps in Chrome's
// Android behaviour:
//   - every GATT step has a timeout (connect() to a powered-off device can hang forever),
//   - advertisement watching (where supported) connects as soon as the controller advertises,
//     with periodic connect attempts as the fallback,
//   - a data watchdog drops a link that claims to be connected but delivers no frames.
import { CHAR_UUID, FrameParser, KEEPALIVE, SERVICE_UUID } from '../protocol/fardriver.js';

const DEVICE_KEY = 'emoto-dash.ctrlDeviceId';
const KEEPALIVE_MS = 1000;

// Name prefixes Fardriver controllers advertise with ("YuanQu" = 远驱, Fardriver's Chinese
// name; e.g. "YuanQuFOC568"). Matching is case-sensitive, hence the variants.
export const CONTROLLER_NAME_PREFIXES = ['YuanQu', 'YUANQU', 'Yuanqu', 'yuanqu', 'FarDriver', 'Fardriver', 'FARDRIVER'];

const DEFAULT_TIMING = {
  retryMinMs: 1000,
  retryMaxMs: 5000,
  connectTimeoutMs: 20000,
  stepTimeoutMs: 8000,
  watchdogMs: 5000,
};

function withTimeout(promise, ms, what) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Filters for Chrome's device chooser. A user-supplied name prefix takes priority; otherwise
// known Fardriver names, plus anything advertising the controller's service.
export function chooserFilters(namePrefix) {
  const custom = namePrefix?.trim();
  if (custom) return [{ namePrefix: custom }];
  return [...CONTROLLER_NAME_PREFIXES.map((p) => ({ namePrefix: p })), { services: [SERVICE_UUID] }];
}

export class FardriverBle extends EventTarget {
  constructor(settings, timing = {}) {
    super();
    this.settings = settings;
    this.timing = { ...DEFAULT_TIMING, ...timing };
    this.device = null;
    this.characteristic = null;
    this.status = 'disconnected';
    this.parser = new FrameParser((f) => {
      this.lastFrameAt = Date.now();
      this.dispatchEvent(new CustomEvent('frame', { detail: f }));
    });
    this.userClosed = false;
    this.connecting = false;
    this.retryMs = this.timing.retryMinMs;
    this.keepAliveTimer = null;
    this.retryTimer = null;
    this.watchdogTimer = null;
    this.watchAbort = null;
    this.lastFrameAt = 0;
    this.attempts = 0;
    this.lastError = '';
    this.reconnectMethod = 'polling';
  }

  static get supported() {
    return typeof navigator !== 'undefined' && !!navigator.bluetooth;
  }

  // Whether Chrome can hand back a previously picked device at launch (auto-connect on start).
  static get canRestore() {
    return FardriverBle.supported && typeof navigator.bluetooth.getDevices === 'function';
  }

  get name() {
    return this.device?.name || 'controller';
  }

  setStatus(status) {
    if (status === this.status) return;
    this.status = status;
    this.dispatchEvent(new CustomEvent('status', { detail: status }));
  }

  // Must be called from a user gesture (it opens Chrome's device chooser).
  // showAll lists every nearby device, for controllers with an unrecognised name.
  async pick({ showAll = false } = {}) {
    const device = await navigator.bluetooth.requestDevice(
      showAll
        ? { acceptAllDevices: true, optionalServices: [SERVICE_UUID] }
        : { filters: chooserFilters(this.settings.controllerName), optionalServices: [SERVICE_UUID] },
    );
    try {
      localStorage.setItem(DEVICE_KEY, device.id);
    } catch {
      // Without storage the device simply has to be picked again next time.
    }
    await this.attach(device);
  }

  // Reattaches to the previously picked device without a chooser, where the browser allows it.
  // Returns true when a remembered device was found; connecting then continues in the background.
  async restore() {
    if (!FardriverBle.canRestore) return false;
    let id = null;
    try {
      id = localStorage.getItem(DEVICE_KEY);
    } catch {
      return false;
    }
    if (!id) return false;
    const devices = await navigator.bluetooth.getDevices();
    const device = devices.find((d) => d.id === id);
    if (!device) return false;
    this.attach(device).catch(() => {}); // a powered-off controller is expected here; keep retrying
    return true;
  }

  async forget() {
    this.disconnect();
    try {
      localStorage.removeItem(DEVICE_KEY);
    } catch {
      // Nothing stored.
    }
    await this.device?.forget?.().catch(() => {});
    this.device = null;
  }

  async attach(device) {
    if (this.device && this.device !== device) {
      this.device.removeEventListener('gattserverdisconnected', this.onDisconnected);
      this.device.removeEventListener('advertisementreceived', this.onAdvertisement);
      this.stopWatching();
    }
    this.device = device;
    this.userClosed = false;
    this.retryMs = this.timing.retryMinMs;
    device.removeEventListener('gattserverdisconnected', this.onDisconnected);
    device.addEventListener('gattserverdisconnected', this.onDisconnected);
    device.removeEventListener('advertisementreceived', this.onAdvertisement);
    device.addEventListener('advertisementreceived', this.onAdvertisement);
    this.setStatus('connecting');
    await this.connect({ throwOnFail: true });
  }

  async connect({ throwOnFail = false } = {}) {
    if (this.connecting || !this.device || this.userClosed) return;
    this.connecting = true;
    clearTimeout(this.retryTimer);
    this.attempts++;
    const t = this.timing;
    try {
      const server = await withTimeout(this.device.gatt.connect(), t.connectTimeoutMs, 'Connect');
      const service = await withTimeout(server.getPrimaryService(SERVICE_UUID), t.stepTimeoutMs, 'Service discovery');
      const ch = await withTimeout(service.getCharacteristic(CHAR_UUID), t.stepTimeoutMs, 'Characteristic discovery');
      // Chrome may hand back the same characteristic object after a reconnect; never listen twice.
      ch.removeEventListener('characteristicvaluechanged', this.onValue);
      ch.addEventListener('characteristicvaluechanged', this.onValue);
      await withTimeout(ch.startNotifications(), t.stepTimeoutMs, 'Enabling notifications');
      this.characteristic = ch;
      this.retryMs = t.retryMinMs;
      this.lastFrameAt = Date.now();
      this.lastError = '';
      this.stopWatching();
      this.setStatus('connected');
      this.startKeepAlive();
      this.startWatchdog();
    } catch (err) {
      this.lastError = err?.message || String(err);
      console.warn('Controller connect failed', err);
      // Abandon a half-open attempt so the next one starts clean.
      try {
        if (this.device?.gatt.connected) this.device.gatt.disconnect();
      } catch {
        // Already gone.
      }
      this.scheduleRetry();
      if (throwOnFail) throw err;
    } finally {
      this.connecting = false;
    }
  }

  // Try right away, e.g. when the app returns to the foreground.
  kick() {
    if (this.status === 'reconnecting' || this.status === 'connecting') {
      this.retryMs = this.timing.retryMinMs;
      this.connect().catch(() => {});
    }
  }

  onValue = (e) => {
    const v = e.target.value;
    this.parser.push(new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
  };

  onDisconnected = () => {
    clearInterval(this.keepAliveTimer);
    clearInterval(this.watchdogTimer);
    this.characteristic = null;
    if (this.userClosed) {
      this.setStatus('disconnected');
      return;
    }
    this.retryMs = this.timing.retryMinMs;
    this.scheduleRetry();
  };

  onAdvertisement = () => {
    if (this.status === 'connected' || this.connecting) return;
    this.stopWatching();
    this.retryMs = this.timing.retryMinMs;
    this.connect().catch(() => {});
  };

  scheduleRetry() {
    clearTimeout(this.retryTimer);
    if (this.userClosed || !this.settings.autoReconnect || !this.device) {
      this.setStatus('disconnected');
      return;
    }
    this.setStatus('reconnecting');
    this.watchForAdvertisements();
    this.retryTimer = setTimeout(() => this.connect().catch(() => {}), this.retryMs);
    this.retryMs = Math.min(this.retryMs * 2, this.timing.retryMaxMs);
  }

  async watchForAdvertisements() {
    if (this.watchAbort || typeof this.device?.watchAdvertisements !== 'function') return;
    const abort = new AbortController();
    this.watchAbort = abort;
    try {
      await this.device.watchAdvertisements({ signal: abort.signal });
      this.reconnectMethod = 'advertisements + polling';
    } catch (err) {
      if (this.watchAbort === abort) this.watchAbort = null;
      this.reconnectMethod = 'polling';
    }
  }

  stopWatching() {
    this.watchAbort?.abort();
    this.watchAbort = null;
  }

  startKeepAlive() {
    clearInterval(this.keepAliveTimer);
    if (!this.settings.keepAlive) return;
    this.keepAliveTimer = setInterval(() => {
      const ch = this.characteristic;
      if (!ch) return;
      const write = ch.writeValueWithoutResponse ? ch.writeValueWithoutResponse(KEEPALIVE) : ch.writeValue(KEEPALIVE);
      write.catch((err) => console.warn('Keep-alive write failed', err));
    }, KEEPALIVE_MS);
  }

  // A controller that lost power can leave Android believing the link is still up for a while.
  startWatchdog() {
    clearInterval(this.watchdogTimer);
    const ms = this.timing.watchdogMs;
    this.watchdogTimer = setInterval(() => {
      if (this.status !== 'connected' || Date.now() - this.lastFrameAt < ms) return;
      this.lastError = `No data for ${Math.round(ms / 1000)} s`;
      clearInterval(this.watchdogTimer);
      try {
        this.device.gatt.disconnect(); // fires gattserverdisconnected -> reconnect loop
      } catch {
        this.onDisconnected();
      }
      if (this.status === 'connected') this.onDisconnected(); // browser did not fire the event
    }, Math.max(250, ms / 5));
  }

  disconnect() {
    this.userClosed = true;
    clearTimeout(this.retryTimer);
    clearInterval(this.keepAliveTimer);
    clearInterval(this.watchdogTimer);
    this.stopWatching();
    if (this.device?.gatt.connected) this.device.gatt.disconnect();
    this.setStatus('disconnected');
  }
}
