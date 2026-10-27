// Fardriver controller BLE protocol, as decoded from the official app (MotorNet6.dll).
// See FARDRIVER REVERSE ENGINEERING/analysis/FARDRIVER_BLE_REALTIME_PROTOCOL.md.
//
// Every notification on characteristic FFEC carries one 16-byte frame:
//   AA | id | 12 data bytes | 2 check bytes
// Legacy controllers (id bit7 = 0) use big-endian words and a byte-sum check.
// Newer controllers (id = 0x80 | index) use little-endian words and a CRC-16/MODBUS
// with a non-standard seed; the index maps to a register via FLASH_READ_ADDR.

export const SERVICE_UUID = 0xffe0;
export const CHAR_UUID = 0xffec;
export const FRAME_LEN = 16;

export const FLASH_READ_ADDR = [
  0xe2, 0xe8, 0xee, 0x00, 0x06, 0x0c, 0x12, 0xe2, 0xe8, 0xee, 0x18, 0x1e, 0x24, 0x2a,
  0xe2, 0xe8, 0xee, 0x30, 0x5d, 0x63, 0x69, 0xe2, 0xe8, 0xee, 0x7c, 0x82, 0x88, 0x8e,
  0xe2, 0xe8, 0xee, 0x94, 0x9a, 0xa0, 0xa6, 0xe2, 0xe8, 0xee, 0xac, 0xb2, 0xb8, 0xbe,
  0xe2, 0xe8, 0xee, 0xc4, 0xca, 0xd0, 0xe2, 0xe8, 0xee, 0xd6, 0xdc, 0xf4, 0xfa,
];

const CRC_HI = new Uint8Array(256);
const CRC_LO = new Uint8Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let b = 0; b < 8; b++) c = c & 1 ? (c >>> 1) ^ 0xa001 : c >>> 1;
  CRC_HI[i] = c & 0xff;
  CRC_LO[i] = c >>> 8;
}

export function crc(bytes, len) {
  let hi = 0x3c;
  let lo = 0x7f;
  for (let k = 0; k < len; k++) {
    const i = hi ^ bytes[k];
    hi = lo ^ CRC_HI[i];
    lo = CRC_LO[i];
  }
  return [hi, lo];
}

export const isNewFormat = (f) => (f[1] & 0xc0) === 0x80;

export function frameValid(f) {
  if (f.length < FRAME_LEN || f[0] !== 0xaa) return false;
  if (isNewFormat(f)) {
    const [hi, lo] = crc(f, 14);
    return f[14] === hi && f[15] === lo;
  }
  let sum = 0;
  for (let i = 0; i < 14; i++) sum += f[i];
  return ((f[14] << 8) | f[15]) === sum;
}

// Reassembles frames from arbitrary notification chunks, resyncing on 0xAA.
export class FrameParser {
  constructor(onFrame) {
    this.onFrame = onFrame;
    this.buf = new Uint8Array(0);
    this.frames = 0;
    this.dropped = 0;
  }

  push(chunk) {
    const buf = new Uint8Array(this.buf.length + chunk.length);
    buf.set(this.buf);
    buf.set(chunk, this.buf.length);
    let i = 0;
    while (buf.length - i >= FRAME_LEN) {
      if (buf[i] === 0xaa && frameValid(buf.subarray(i, i + FRAME_LEN))) {
        this.frames++;
        this.onFrame(buf.slice(i, i + FRAME_LEN));
        i += FRAME_LEN;
      } else {
        this.dropped++;
        i++;
      }
    }
    this.buf = buf.slice(i);
  }
}

const s16 = (v) => (v & 0x8000 ? v - 0x10000 : v);
const s8 = (v) => (v & 0x80 ? v - 0x100 : v);
const phaseAmps = (raw24) => 1.953125 * Math.sqrt(raw24);

// Wheel rolling direction exactly as the official app's runView: 1 forward, -1 backward, 0 still.
function rollDirection(nibble, gear) {
  if (nibble === 0) return 0;
  if (nibble === 1) return gear === 2 ? -1 : 1;
  return gear >= 2 ? 1 : -1;
}

function decodeLegacy(f) {
  const be = (i) => (f[i] << 8) | f[i + 1];
  switch (f[1]) {
    case 0: {
      const gear = f[4] & 3;
      return {
        gear,
        speedSwitch: ((f[4] >> 2) ^ 2) & 3,
        rollDir: rollDirection(f[4] >> 4, gear),
        eabsEnabled: (f[5] & 3) === 2,
        motorRpm: s16(be(6)),
        faults: f[8] | ((f[9] & 0x7f) << 8),
        brake: (f[9] & 0x80) !== 0,
      };
    }
    case 1:
      return {
        voltage: s16(be(2)) / 10,
        lineCurrent: s16(be(4)) / 4,
        modulation: f[6] / 128,
        fieldWeakening: (f[7] & 1) === 1,
        throttleDepth: be(12),
      };
    case 2:
      return {
        phaseA: phaseAmps((f[2] << 16) | (f[3] << 8) | f[4]),
        phaseC: phaseAmps((f[9] << 16) | (f[10] << 8) | f[11]),
      };
    case 4:
      return { mosTemp: s8(f[4]) };
    case 8:
      return { polePairs: f[10] };
    case 10:
      return { soc: f[10] };
    case 13:
      return {
        motorTemp: s8(f[2]),
        throttleVoltage: (be(4) * 3.3 * 1.5) / 4096,
        fwVersion: f[10],
      };
    case 15:
      return {
        functionState: f[2],
        motorStopState: be(4),
        global1: be(6),
        global2: be(8),
        global3: be(10),
        global4: be(12),
      };
    default:
      return {};
  }
}

function decodeNew(f) {
  const le = (i) => f[i] | (f[i + 1] << 8);
  const index = f[1] & 0x7f;
  if (index >= FLASH_READ_ADDR.length) return {};
  switch (FLASH_READ_ADDR[index]) {
    case 0xe2: {
      const gear = f[2] & 3;
      const rolling = (f[2] >> 5) & 1;
      const backward = (f[2] >> 4) & 1;
      return {
        gear,
        speedSwitch: (f[2] >> 2) & 3,
        rollDir: rolling ? (backward ? -1 : 1) : 0,
        faults: f[4] | ((f[5] & 0x7f) << 8),
        brake: (f[5] & 0x80) !== 0,
        modulation: f[6] / 128,
        motorRpm: s16(le(8)),
      };
    }
    case 0xe8:
      return { voltage: s16(le(2)) / 10, lineCurrent: s16(le(6)) / 4, throttleDepth: le(12) };
    case 0xee:
      return {
        phaseA: phaseAmps((f[6] << 16) | (f[7] << 8) | f[8]),
        phaseC: phaseAmps((f[9] << 16) | (f[10] << 8) | f[11]),
      };
    case 0x82:
      return { throttleVoltage: le(2) * 0.01, fwVersion: f[11] };
    case 0xd6:
      return { global1: le(4), global2: le(6), global3: le(8), global4: le(10), mosTemp: s16(le(12)) };
    case 0xf4:
      return { soc: f[5], motorTemp: s16(le(2)) };
    case 0xfa:
      return { motorStopState: le(6) };
    case 0x12:
      return { polePairs: f[6] };
    default:
      return {};
  }
}

// Returns a partial telemetry patch for one validated frame.
export function decodeFrame(f) {
  return isNewFormat(f) ? decodeNew(f) : decodeLegacy(f);
}

const FAULT_NAMES = [
  'Motor hall error', 'Throttle error', 'Current protect restart', 'Phase current surge',
  null, 'Anti-theft alarm', 'Motor over-temp', 'Controller over-temp',
  'Phase current overflow', 'Phase zero error', null, 'Line current zero error',
  'MOSFET high side', 'MOSFET low side', 'MOE current protect',
];

// Human-readable fault list, with the same context-dependent wording as the official app.
export function describeFaults({ faults = 0, global1 = 0, global2 = 0, motorStopState = 0 }) {
  const out = [];
  for (let bit = 0; bit < 15; bit++) {
    if (!(faults & (1 << bit))) continue;
    if (bit === 4) out.push(global2 & 0x8000 ? 'Over-voltage' : 'Under-voltage');
    else if (bit === 10) out.push(global1 & 0x0800 ? 'Phase lost' : 'Phase short');
    else if (bit === 12 && faults & (1 << 13)) out.push('Fake controller?');
    else out.push(FAULT_NAMES[bit]);
  }
  // Bit 15 is also set by an ordinary brake pull; like the official app, only report it
  // alongside a real fault.
  if (out.length && motorStopState & 0x8000) out.push('Brake alarm');
  return out;
}

// App -> controller command (SendRs232Data): AA cmd ~cmd sub a b sum ~sum
export function buildCommand(cmd, sub, a, b) {
  const p = new Uint8Array(8);
  p[0] = 0xaa;
  p[1] = cmd;
  p[2] = ~cmd & 0xff;
  p[3] = sub;
  p[4] = a;
  p[5] = b;
  p[6] = (p[0] + p[1] + p[2] + p[3] + p[4] + p[5]) & 0xff;
  p[7] = ~p[6] & 0xff;
  return p;
}

// The periodic packet the official app sent in the recorded session (AA 13 EC 07 09 5F 18 E7).
export const KEEPALIVE = buildCommand(0x13, 0x07, 0x09, 0x5f);

// Builds a valid legacy frame; `write(f)` fills data bytes f[2]..f[13] using the same
// offsets as decodeLegacy. Used by the demo source and tests.
export function encodeLegacyFrame(index, write) {
  const f = new Uint8Array(FRAME_LEN);
  f[0] = 0xaa;
  f[1] = index;
  if (write) write(f);
  let sum = 0;
  for (let i = 0; i < 14; i++) sum += f[i];
  f[14] = sum >> 8;
  f[15] = sum & 0xff;
  return f;
}
