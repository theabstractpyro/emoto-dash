// Web Bluetooth link to the Fardriver controller (service FFE0, characteristic FFEC).
//
// Source interface shared with DemoSource and future sources (e.g. a BMS):
//   EventTarget emitting
//     'status' -> detail: 'disconnected' | 'connecting' | 'connected' | 'reconnecting'
//     'frame'  -> detail: Uint8Array(16), an already-validated controller frame
import { CHAR_UUID, FrameParser, KEEPALIVE, SERVICE_UUID } from '../protocol/fardriver.js';

const DEVICE_KEY = 'emoto-dash.ctrlDeviceId';
const KEEPALIVE_MS = 1000;

export class FardriverBle extends EventTarget {
  constructor(settings) {
    super();
    this.settings = settings;
    this.device = null;
    this.characteristic = null;
    this.status = 'disconnected';
    this.parser = new FrameParser((f) => this.dispatchEvent(new CustomEvent('frame', { detail: f })));
    this.userClosed = false;
    this.retryMs = 1000;
    this.keepAliveTimer = null;
    this.retryTimer = null;
    this.onDisconnected = this.onDisconnected.bind(this);
  }

  static get supported() {
    return typeof navigator !== 'undefined' && !!navigator.bluetooth;
  }

  get name() {
    return this.device?.name || 'controller';
  }

  setStatus(status) {
    this.status = status;
    this.dispatchEvent(new CustomEvent('status', { detail: status }));
  }

  // Must be called from a user gesture (it opens Chrome's device chooser).
  async pick() {
    // The controller's advertised name is not known, so list every device that might expose FFE0.
    const device = await navigator.bluetooth.requestDevice({
      acceptAllDevices: true,
      optionalServices: [SERVICE_UUID],
    });
    try {
      localStorage.setItem(DEVICE_KEY, device.id);
    } catch {
      // Without storage the device simply has to be picked again next time.
    }
    await this.attach(device);
  }

  // Reconnects to the previously picked device without a chooser, where the browser allows it.
  async restore() {
    if (!navigator.bluetooth?.getDevices) return false;
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
    await this.attach(device);
    return true;
  }

  async attach(device) {
    if (this.device && this.device !== device) this.device.removeEventListener('gattserverdisconnected', this.onDisconnected);
    this.device = device;
    this.userClosed = false;
    device.addEventListener('gattserverdisconnected', this.onDisconnected);
    await this.connect();
  }

  async connect() {
    clearTimeout(this.retryTimer);
    const firstAttempt = this.status !== 'reconnecting';
    this.setStatus(firstAttempt ? 'connecting' : 'reconnecting');
    try {
      const server = await this.device.gatt.connect();
      const service = await server.getPrimaryService(SERVICE_UUID);
      const ch = await service.getCharacteristic(CHAR_UUID);
      // Chrome may hand back the same characteristic object after a reconnect; never listen twice.
      ch.removeEventListener('characteristicvaluechanged', this.onValue);
      ch.addEventListener('characteristicvaluechanged', this.onValue);
      await ch.startNotifications();
      this.characteristic = ch;
      this.retryMs = 1000;
      this.setStatus('connected');
      this.startKeepAlive();
    } catch (err) {
      console.warn('Controller connect failed', err);
      this.scheduleRetry();
      if (firstAttempt) throw err;
    }
  }

  onValue = (e) => {
    const v = e.target.value;
    this.parser.push(new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
  };

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

  onDisconnected() {
    clearInterval(this.keepAliveTimer);
    this.characteristic = null;
    if (this.userClosed) {
      this.setStatus('disconnected');
      return;
    }
    this.scheduleRetry();
  }

  scheduleRetry() {
    clearTimeout(this.retryTimer);
    if (this.userClosed || !this.settings.autoReconnect || !this.device) {
      this.setStatus('disconnected');
      return;
    }
    if (this.status !== 'reconnecting') this.setStatus('reconnecting');
    this.retryTimer = setTimeout(() => this.connect().catch(() => {}), this.retryMs);
    this.retryMs = Math.min(this.retryMs * 2, 10000);
  }

  disconnect() {
    this.userClosed = true;
    clearTimeout(this.retryTimer);
    clearInterval(this.keepAliveTimer);
    if (this.device?.gatt.connected) this.device.gatt.disconnect();
    else this.setStatus('disconnected');
  }
}
