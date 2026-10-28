// Native (Android app) link to the Fardriver controller, via the Capacitor Bluetooth LE plugin.
//
// Same interface as FardriverBle ('status' and 'frame' events, pick/restore/forget/kick/
// disconnect), but it needs no device chooser: the controller takes a new random Bluetooth
// address at every power-up, so this source scans continuously for its *name* and connects
// to whatever address it has today. Key on -> scan finds it -> connected, with no taps.
import { FrameParser, KEEPALIVE } from '../protocol/fardriver.js';
import { CONTROLLER_NAME_PREFIXES } from './fardriver-ble.js';
import { logLink } from '../link-log.js';

const SERVICE = '0000ffe0-0000-1000-8000-00805f9b34fb';
const CHAR = '0000ffec-0000-1000-8000-00805f9b34fb';
const NAME_KEY = 'emoto-dash.nativeCtrlName';
const KEEPALIVE_HEX = Array.from(KEEPALIVE, (b) => b.toString(16).padStart(2, '0')).join('');
const SCAN_MODE_LOW_LATENCY = 2;
const CONNECTION_PRIORITY_HIGH = 1;

const DEFAULT_TIMING = {
  connectTimeoutMs: 10000,
  watchdogMs: 5000,
  rescanMs: 4 * 60 * 1000, // Android quietly stops long-running scans; restart periodically
  retryMs: 1500,
};

export const nativePlugin = () => globalThis.Capacitor?.Plugins?.BluetoothLe ?? null;
export const isNativeApp = () => !!nativePlugin();

function hexToBytes(hex) {
  const clean = String(hex ?? '').replace(/[^0-9a-f]/gi, '');
  const out = new Uint8Array(clean.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out;
}

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
    // The saved name is a convenience; without it, any Fardriver-named controller is used.
  }
}

export class FardriverNative extends EventTarget {
  constructor(settings, { plugin = nativePlugin(), timing = {} } = {}) {
    super();
    this.settings = settings;
    this.plugin = plugin;
    this.timing = { ...DEFAULT_TIMING, ...timing };
    this.status = 'disconnected';
    this.deviceId = null;
    this.deviceName = null;
    this.userClosed = true;
    this.scanning = false;
    this.connecting = false;
    this.initialized = false;
    this.listeners = [];
    this.linkListeners = []; // per-connection: removed when the link drops
    this.parser = new FrameParser((f) => {
      this.lastFrameAt = Date.now();
      if (!this.firstFrameLogged) {
        this.firstFrameLogged = true;
        logLink('Receiving data');
      }
      this.dispatchEvent(new CustomEvent('frame', { detail: f }));
    });
    this.lastFrameAt = 0;
    this.attempts = 0;
    this.lastError = '';
    this.problem = null; // 'bluetooth-off' | 'location-off' | 'permission' | null
    this.reconnectMethod = 'native scan by name';
  }

  static get rememberedName() {
    return storageGet(NAME_KEY);
  }

  get name() {
    return this.deviceName || storageGet(NAME_KEY) || 'controller';
  }

  get device() {
    // Lets shared UI code treat "a controller is configured" the same way as the web source.
    return this.userClosed ? null : { name: this.name };
  }

  setStatus(status) {
    if (status === this.status) return;
    this.status = status;
    this.dispatchEvent(new CustomEvent('status', { detail: status }));
  }

  // Which advertised names count as the controller.
  matches(name) {
    if (!name) return false;
    const custom = this.settings.controllerName?.trim();
    if (custom) return name.startsWith(custom);
    return CONTROLLER_NAME_PREFIXES.some((p) => name.startsWith(p));
  }

  async init() {
    if (this.initialized) return true;
    try {
      await this.plugin.initialize({ androidNeverForLocation: true });
      this.initialized = true;
    } catch (err) {
      this.problem = 'permission';
      this.lastError = `Bluetooth permission: ${err?.message || err}`;
      logLink(this.lastError);
      return false;
    }
    try {
      const listener = await this.plugin.addListener('onScanResult', (r) => this.onScanResult(r));
      this.listeners.push(listener);
    } catch (err) {
      logLink(`Scan listener failed: ${err?.message || err}`);
    }
    return true;
  }

  // Starts searching; connects automatically whenever the controller is powered on.
  async start() {
    this.userClosed = false;
    this.setStatus('connecting');
    if (!(await this.init())) return;
    await this.searchSoon(0);
  }

  async checkRadios() {
    try {
      if (!(await this.plugin.isEnabled()).value) {
        this.problem = 'bluetooth-off';
        return false;
      }
    } catch {
      // Unknown: try scanning anyway.
    }
    this.problem = null;
    return true;
  }

  searchSoon(ms = this.timing.retryMs) {
    clearTimeout(this.searchTimer);
    return new Promise((resolve) => {
      this.searchTimer = setTimeout(() => this.startScan().finally(resolve), ms);
    });
  }

  async startScan() {
    if (this.userClosed || this.status === 'connected' || this.connecting) return;
    if (!(await this.checkRadios())) {
      if (this.lastError !== 'Bluetooth is off') logLink('Bluetooth is off');
      this.lastError = 'Bluetooth is off';
      this.setStatus('reconnecting');
      this.searchSoon(3000);
      return;
    }
    await this.stopScan();
    try {
      // No name filter: the plugin takes a single prefix, and the controller may use several.
      await this.plugin.requestLEScan({ allowDuplicates: false, scanMode: SCAN_MODE_LOW_LATENCY });
      this.scanning = true;
      this.setStatus(this.status === 'connecting' ? 'connecting' : 'reconnecting');
      logLink(`Scanning for ${this.settings.controllerName?.trim() || 'Fardriver controllers'}`);
      clearTimeout(this.rescanTimer);
      this.rescanTimer = setTimeout(() => this.startScan(), this.timing.rescanMs);
    } catch (err) {
      this.lastError = `Scan failed: ${err?.message || err}`;
      logLink(this.lastError);
      // Location services are required for BLE scanning on Android 11 and older.
      try {
        if (!(await this.plugin.isLocationEnabled()).value) this.problem = 'location-off';
      } catch {
        // Not available on this Android version.
      }
      this.setStatus('reconnecting');
      this.searchSoon(5000);
    }
  }

  async stopScan() {
    clearTimeout(this.rescanTimer);
    if (!this.scanning) return;
    this.scanning = false;
    try {
      await this.plugin.stopLEScan();
    } catch {
      // Already stopped.
    }
  }

  onScanResult(result) {
    const name = result?.localName || result?.device?.name;
    if (this.choiceCallback) this.choiceCallback({ name, deviceId: result?.device?.deviceId, rssi: result?.rssi });
    if (this.userClosed || this.connecting || this.status === 'connected' || !this.matches(name)) return;
    // Prefer the controller we used last time when several are nearby (e.g. group rides).
    const saved = storageGet(NAME_KEY);
    if (saved && name !== saved && !this.settings.controllerName?.trim()) {
      this.otherSeenAt ??= Date.now();
      if (Date.now() - this.otherSeenAt < 4000) return; // give the saved one a moment to show up
    }
    this.otherSeenAt = null;
    logLink(`Found "${name}" (rssi ${result?.rssi ?? '?'})`);
    this.connectTo(result.device.deviceId, name);
  }

  async connectTo(deviceId, name) {
    if (this.connecting) return;
    this.connecting = true;
    this.attempts++;
    await this.stopScan();
    const p = this.plugin;
    try {
      await this.removeLinkListeners();
      const dropKey = `disconnected|${deviceId}`;
      this.linkListeners.push(await p.addListener(dropKey, () => this.onDisconnected(deviceId)));
      await p.connect({ deviceId, timeout: this.timing.connectTimeoutMs });
      await p.requestConnectionPriority?.({ deviceId, connectionPriority: CONNECTION_PRIORITY_HIGH }).catch(() => {});
      const notifyKey = `notification|${deviceId}|${SERVICE}|${CHAR}`;
      this.linkListeners.push(await p.addListener(notifyKey, (e) => this.parser.push(hexToBytes(e?.value))));
      await p.startNotifications({ deviceId, service: SERVICE, characteristic: CHAR });
      this.deviceId = deviceId;
      this.deviceName = name;
      storageSet(NAME_KEY, name);
      this.lastFrameAt = Date.now();
      this.firstFrameLogged = false;
      this.lastError = '';
      logLink(`Connected to "${name}" after ${this.attempts} attempt(s)`);
      this.attempts = 0;
      this.setStatus('connected');
      this.startKeepAlive();
      this.startWatchdog();
    } catch (err) {
      this.lastError = err?.message || String(err);
      logLink(`Connect failed: ${this.lastError}`);
      p.disconnect({ deviceId }).catch(() => {});
      this.setStatus('reconnecting');
      this.searchSoon();
    } finally {
      this.connecting = false;
    }
  }

  onDisconnected(deviceId) {
    if (deviceId !== this.deviceId || this.status !== 'connected') return;
    logLink(this.userClosed ? 'Disconnected by user' : 'Link dropped (controller off or out of range)');
    this.dropLink();
  }

  async removeLinkListeners() {
    const handles = this.linkListeners;
    this.linkListeners = [];
    for (const h of handles) {
      try {
        await (await h)?.remove?.();
      } catch {
        // Already gone.
      }
    }
  }

  dropLink() {
    this.removeLinkListeners();
    clearInterval(this.keepAliveTimer);
    clearInterval(this.watchdogTimer);
    this.deviceId = null;
    if (this.userClosed) {
      this.setStatus('disconnected');
      return;
    }
    this.setStatus('reconnecting');
    this.searchSoon(); // the controller will come back under a new address; find it by name
  }

  startKeepAlive() {
    clearInterval(this.keepAliveTimer);
    if (!this.settings.keepAlive) return;
    this.keepAliveTimer = setInterval(() => {
      if (!this.deviceId) return;
      this.plugin
        .writeWithoutResponse({ deviceId: this.deviceId, service: SERVICE, characteristic: CHAR, value: KEEPALIVE_HEX })
        .catch(() => {});
    }, 1000);
  }

  startWatchdog() {
    clearInterval(this.watchdogTimer);
    const ms = this.timing.watchdogMs;
    this.watchdogTimer = setInterval(() => {
      if (this.status !== 'connected' || Date.now() - this.lastFrameAt < ms) return;
      this.lastError = `No data for ${Math.round(ms / 1000)} s`;
      logLink(`${this.lastError}; restarting the link`);
      const id = this.deviceId;
      this.plugin.disconnect({ deviceId: id }).catch(() => {});
      this.dropLink();
    }, Math.max(250, ms / 5));
  }

  // --- Interface shared with FardriverBle -------------------------------------------------

  // Native connects by name, so "picking" just (re)starts the search. showAll is handled by
  // the in-app chooser (see chooseFromScan).
  async pick() {
    await this.start();
  }

  async restore() {
    await this.start();
    return true;
  }

  kick() {
    if (!this.userClosed && this.status !== 'connected') this.searchSoon(0);
  }

  async forget() {
    storageSet(NAME_KEY, null);
    logLink('Remembered controller name cleared');
    this.disconnect();
  }

  // Lists nearby named devices for a few seconds so the user can pick an unknown controller.
  async chooseFromScan(onDevice) {
    if (!(await this.init())) return () => {};
    this.choiceCallback = onDevice;
    if (!this.scanning) {
      await this.plugin.requestLEScan({ allowDuplicates: false, scanMode: SCAN_MODE_LOW_LATENCY }).catch(() => {});
      this.scanning = true;
    }
    return () => {
      this.choiceCallback = null;
    };
  }

  disconnect() {
    this.userClosed = true;
    clearTimeout(this.searchTimer);
    clearInterval(this.keepAliveTimer);
    clearInterval(this.watchdogTimer);
    this.stopScan();
    if (this.deviceId) this.plugin.disconnect({ deviceId: this.deviceId }).catch(() => {});
    this.deviceId = null;
    this.setStatus('disconnected');
  }
}
