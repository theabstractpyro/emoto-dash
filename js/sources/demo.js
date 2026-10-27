// Simulated ride that emits genuine legacy-format controller frames, so the demo exercises the
// same parser, decoder and UI path as the real Bluetooth link. Same interface as FardriverBle.
import { FrameParser, encodeLegacyFrame } from '../protocol/fardriver.js';
import { rpmToKmh } from '../store.js';

// Frame order observed from the real controller: fast frames 0/1/2 between every slow group.
const SCHEDULE = [0, 1, 2, 3, 4, 6, 0, 1, 2, 7, 8, 9, 0, 1, 2, 10, 11, 12, 0, 1, 2, 13, 14, 15, 0, 1, 2, 16, 17, 18, 0, 1, 2, 19, 20, 21];

// [seconds, target mph, speed switch 0-2, flags]
const SCRIPT = [
  [5, 0, 1, { brake: true }],
  [10, 45, 1, {}],
  [4, 45, 1, {}],
  [5, 45, 1, { cruise: true }],
  [5, 20, 1, { brake: true }],
  [9, 68, 2, { boost: true }],
  [7, 65, 2, {}],
  [9, 0, 0, { brake: true }],
  [4, 0, 0, {}],
];

const MASS_KG = 190;
const R_INTERNAL = 0.04;
const STEP_S = 0.1;

export class DemoSource extends EventTarget {
  constructor(settings, { faults = false } = {}) {
    super();
    this.settings = settings;
    this.withFaults = faults;
    this.status = 'disconnected';
    this.name = 'Demo ride';
    this.parser = new FrameParser((f) => this.dispatchEvent(new CustomEvent('frame', { detail: f })));
    this.sim = { t: 0, ms: 0, soc: 82, motorTemp: 34, mosTemp: 30, current: 0, voltage: 0 };
    this.slot = 0;
  }

  setStatus(status) {
    this.status = status;
    this.dispatchEvent(new CustomEvent('status', { detail: status }));
  }

  start() {
    this.setStatus('connected');
    this.timer = setInterval(() => this.step(), STEP_S * 1000);
  }

  disconnect() {
    clearInterval(this.timer);
    this.setStatus('disconnected');
  }

  segment() {
    const total = SCRIPT.reduce((a, s) => a + s[0], 0);
    let t = this.sim.t % total;
    for (const seg of SCRIPT) {
      if (t < seg[0]) return seg;
      t -= seg[0];
    }
    return SCRIPT[0];
  }

  step() {
    const s = this.sim;
    const [, targetMph, speedSwitch, flags] = this.segment();
    const target = targetMph / 2.23694;
    const maxAccel = speedSwitch === 2 ? 2.4 : speedSwitch === 1 ? 1.6 : 1.0;
    const decel = flags.brake ? 3.2 : 1.2;
    const dv = Math.max(-decel * STEP_S, Math.min(maxAccel * STEP_S, target - s.ms));
    const accel = dv / STEP_S;
    s.ms = Math.max(0, s.ms + dv);

    const dragW = 25 * s.ms + 0.21 * s.ms ** 3;
    let powerW = s.ms > 0.1 ? dragW + MASS_KG * accel * s.ms : 0;
    if (powerW < 0) powerW = Math.max(powerW * 0.6, -this.settings.maxRegenKw * 1000 * 0.8);

    const openCircuit = this.settings.cellCount * (3.35 + (0.85 * s.soc) / 100);
    s.current = powerW / openCircuit;
    s.voltage = openCircuit - s.current * R_INTERNAL;
    // Drains ~10x faster than reality so the demo visibly moves.
    s.soc = Math.max(5, s.soc - ((powerW * STEP_S) / 3600 / (this.settings.cellCount * 3.6 * this.settings.capacityAh)) * 100 * 10);
    s.motorTemp += (s.current ** 2 * 0.00002 - (s.motorTemp - 30) * 0.004) * STEP_S * 10;
    s.mosTemp += (s.current ** 2 * 0.000015 - (s.mosTemp - 28) * 0.006) * STEP_S * 10;
    s.t += STEP_S;

    const kmhPerRpm = rpmToKmh(1, this.settings);
    const state = {
      gear: 1,
      speedSwitch,
      rpm: Math.round((s.ms * 3.6) / kmhPerRpm),
      brake: !!flags.brake,
      cruise: !!flags.cruise,
      boost: !!flags.boost,
      faults: this.withFaults ? 0x0040 : 0,
      throttle: powerW > 0 ? Math.min(1, powerW / 12000 + 0.15) : 0,
      modulation: Math.min(0.98, s.ms / 32),
      ...s,
    };
    for (let i = 0; i < 4; i++) {
      this.parser.push(encodeDemoFrame(SCHEDULE[this.slot], state));
      this.slot = (this.slot + 1) % SCHEDULE.length;
    }
  }
}

export function encodeDemoFrame(index, st) {
  return encodeLegacyFrame(index, (f) => {
    const be = (i, v) => {
      f[i] = (v >> 8) & 0xff;
      f[i + 1] = v & 0xff;
    };
    const phase = Math.abs(st.current) / Math.max(st.modulation, 0.15);
    const phaseRaw = Math.min(0xffffff, Math.round((phase / 1.953125) ** 2));
    switch (index) {
      case 0:
        f[4] = st.gear | (((st.speedSwitch ^ 2) & 3) << 2) | ((st.rpm > 0 ? 1 : 0) << 4);
        f[5] = 2 | (2 << 2);
        be(6, st.rpm & 0xffff);
        f[8] = st.faults & 0xff;
        f[9] = ((st.faults >> 8) & 0x7f) | (st.brake ? 0x80 : 0);
        break;
      case 1:
        be(2, Math.round(st.voltage * 10));
        be(4, Math.round(st.current * 4) & 0xffff);
        f[6] = Math.round(st.modulation * 128);
        be(12, Math.round(st.throttle * 127));
        break;
      case 2:
        f[2] = phaseRaw >> 16;
        f[3] = (phaseRaw >> 8) & 0xff;
        f[4] = phaseRaw & 0xff;
        f[9] = phaseRaw >> 16;
        f[10] = (phaseRaw >> 8) & 0xff;
        f[11] = phaseRaw & 0xff;
        break;
      case 4:
        f[4] = Math.round(st.mosTemp) & 0xff;
        break;
      case 8:
        f[10] = 4;
        break;
      case 10:
        f[10] = Math.round(st.soc);
        break;
      case 13:
        f[2] = Math.round(st.motorTemp) & 0xff;
        be(4, Math.round(((0.8 + st.throttle * 3.4) * 4096) / (3.3 * 1.5)));
        f[10] = 55;
        break;
      case 15:
        be(4, st.cruise ? 0x0002 : 0);
        be(10, st.boost ? 0x0004 : 0);
        break;
    }
  });
}
