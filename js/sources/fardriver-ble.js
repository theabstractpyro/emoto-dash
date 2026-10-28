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
import { logLink } from '../link-log.js';

const DEVICE_KEY = 'emoto-dash.ctrlDeviceId';
const NAME_KEY = 'emoto-dash.ctrlDeviceName';

function storageGet(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function storageSet(key, value) {
  try {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Without storage the device simply has to be picked again next time.
  }
}
const KEEPALIVE_MS = 1000;

// Name prefixes Fardriver controllers advertise with ("YuanQu" = 远驱, Fardriver's Chinese
// name; e.g. "YuanQuFOC568"). Matching is case-sensitive, hence the variants.
export const CONTROLLER_NAME_PREFIXES = ['YuanQu', 'YUANQU', 'Yuanqu', 'yuanqu', 'FarDriver', 'Fardriver', 'FARDRIVER'];

const DEFAULT_TIMING = {
  retryMinMs: 1000,
  retryMaxMs: 5000,
  connectTimeoutMs: 12000,
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
      if (!this.firstFrameLogged) {
        this.firstFrameLogged = true;
        logLink('Receiving data');
      }
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
    this.firstFrameLogged = false;
  }

  // Name of the remembered controller, if any (shown in Settings).
  static get rememberedName() {
    return storageGet(DEVICE_KEY) ? storageGet(NAME_KEY) || 'unnamed device' : null;
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
    logLink(`Opening device chooser${showAll ? ' (all devices)' : ''}`);
    const device = await navigator.bluetooth.requestDevice(
      showAll
        ? { acceptAllDevices: true, optionalServices: [SERVICE_UUID] }
        : { filters: chooserFilters(this.settings.controllerName), optionalServices: [SERVICE_UUID] },
    );
    logLink(`Picked "${device.name || '?'}" (id ${device.id.slice(0, 8)}…)`);
    storageSet(DEVICE_KEY, device.id);
    storageSet(NAME_KEY, device.name || '');
    this.forgetStaleControllers(device);
    await this.attach(device);
  }

  // Reattaches to the previously picked device without a chooser, where the browser allows it.
  // Returns true when a remembered device was found; connecting then continues in the background.
  // Returns true when reattached, otherwise a reason: 'unsupported' | 'none' | 'not-found'.
  async restore() {
    if (!FardriverBle.canRestore) {
      logLink('Launch: Chrome cannot restore devices (flag off)');
      return 'unsupported';
    }
    const id = storageGet(DEVICE_KEY);
    const name = storageGet(NAME_KEY);
    const devices = await navigator.bluetooth.getDevices();
    const names = devices.map((d) => d.name || '?').join(', ');
    logLink(`Launch: Chrome remembers ${devices.length} device(s)${devices.length ? `: ${names}` : ''}; saved "${name || '-'}"`);
    // Prefer the saved id, then the saved name, then a lone device with a Fardriver-style name.
    // Ids can change when Chrome's permission backend changes, so the fallbacks matter.
    const looksLikeController = (d) => CONTROLLER_NAME_PREFIXES.some((p) => d.name?.startsWith(p));
    const candidates = devices.filter(looksLikeController);
    const device = devices.find((d) => id && d.id === id)
      || devices.find((d) => name && d.name === name)
      || (candidates.length === 1 ? candidates[0] : null);
    if (!device) {
      logLink(devices.length
        ? 'Launch: none of them is the controller; pick it once more'
        : 'Launch: nothing to restore; pick the controller once (flag on) and Chrome will keep it');
      return devices.length ? 'not-found' : 'none';
    }
    storageSet(DEVICE_KEY, device.id);
    storageSet(NAME_KEY, device.name || '');
    logLink(`Launch: restoring "${device.name || '?'}"`);
    this.attach(device).catch(() => {}); // a powered-off controller is expected here; keep retrying
    return true;
  }

  // The controller takes a new Bluetooth address at every power-up, so each pick leaves the
  // previous one behind in Chrome's remembered list. Drop those so the list stays clean.
  async forgetStaleControllers(keep) {
    if (typeof navigator.bluetooth?.getDevices !== 'function') return;
    try {
      const devices = await navigator.bluetooth.getDevices();
      let removed = 0;
      for (const d of devices) {
        if (d.id === keep.id || typeof d.forget !== 'function') continue;
        const name = d.name || '';
        const stale = !name || name.startsWith('Unknown or Unsupported Device')
          || CONTROLLER_NAME_PREFIXES.some((p) => name.startsWith(p));
        if (!stale) continue;
        await d.forget();
        removed++;
      }
      if (removed) logLink(`Removed ${removed} old controller entr${removed === 1 ? 'y' : 'ies'} from Chrome's list`);
    } catch (err) {
      logLink(`Could not tidy remembered devices: ${err?.message || err}`);
    }
  }

  async forget() {
    this.disconnect();
    logLink('Controller forgotten');
    storageSet(DEVICE_KEY, null);
    storageSet(NAME_KEY, null);
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
    // Devices restored at launch may need an advertisement before Chrome can connect to them.
    this.watchForAdvertisements();
    await this.connect({ throwOnFail: true });
  }

  async connect({ throwOnFail = false } = {}) {
    if (this.connecting || !this.device || this.userClosed) return;
    this.connecting = true;
    clearTimeout(this.retryTimer);
    this.attempts++;
    if (this.attempts <= 3 || this.attempts % 10 === 0) logLink(`Connect attempt ${this.attempts}`);
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
      this.firstFrameLogged = false;
      logLink(`Connected to "${this.device.name || '?'}" after ${this.attempts} attempt(s)`);
      this.attempts = 0;
      this.setStatus('connected');
      this.startKeepAlive();
      this.startWatchdog();
    } catch (err) {
      const message = err?.message || String(err);
      if (message !== this.lastError || this.attempts <= 3) logLink(`Connect failed: ${message}`);
      this.lastError = message;
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
    logLink(this.userClosed ? 'Disconnected by user' : 'Link dropped (controller off or out of range)');
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

  onAdvertisement = (e) => {
    if (this.status === 'connected' || this.connecting) return;
    logLink(`Controller advertising (rssi ${e?.rssi ?? '?'}), connecting`);
    this.stopWatching();
    this.retryMs = this.timing.retryMinMs;
    this.connect().catch(() => {});
  };

  scheduleRetry() {
    clearTimeout(this.retryTimer);
    if (this.userClosed || !this.settings.autoReconnect || !this.device) {
      if (!this.userClosed && this.device) logLink('Not retrying: "Reconnect automatically" is off');
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
      if (this.reconnectMethod !== 'advertisements + polling') logLink('Watching for controller advertisements');
      this.reconnectMethod = 'advertisements + polling';
    } catch (err) {
      if (this.watchAbort === abort) this.watchAbort = null;
      if (err?.name !== 'AbortError') logLink(`Advertisement watch unavailable: ${err?.message || err}`);
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
      logLink(`${this.lastError}; restarting the link`);
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
