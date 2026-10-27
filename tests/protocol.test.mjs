import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  FrameParser, KEEPALIVE, buildCommand, crc, decodeFrame, describeFaults, encodeLegacyFrame, frameValid,
} from '../js/protocol/fardriver.js';
import { encodeDemoFrame } from '../js/sources/demo.js';

const hex = (u8) => Buffer.from(u8).toString('hex');
const CAPTURE = fileURLToPath(new URL('../../FARDRIVER REVERSE ENGINEERING/analysis/data/btsnoop_att.jsonl', import.meta.url));

test('decodes every frame of the recorded btsnoop session', { skip: !existsSync(CAPTURE) && 'capture not present' }, () => {
  const notifications = readFileSync(CAPTURE, 'utf8').trim().split('\n').map(JSON.parse).filter((r) => r.op === 0x1b);
  const decoded = [];
  const parser = new FrameParser((f) => decoded.push(decodeFrame(f)));
  // Feed the stream in odd-sized chunks to exercise reassembly across notification boundaries.
  const stream = Buffer.from(notifications.map((r) => r.value).join(''), 'hex');
  for (let i = 0; i < stream.length; i += 7) parser.push(stream.subarray(i, i + 7));

  assert.equal(parser.frames, 3947);
  const values = (k) => decoded.map((p) => p[k]).filter((v) => v != null);
  const range = (k) => [Math.min(...values(k)), Math.max(...values(k))];
  assert.deepEqual(range('voltage'), [75.3, 75.6]);
  assert.deepEqual(range('lineCurrent'), [0, 5.25]);
  assert.deepEqual(range('motorRpm'), [0, 112]);
  assert.deepEqual(range('soc'), [65, 65]);
  assert.deepEqual(range('polePairs'), [4, 4]);
  assert.deepEqual(range('fwVersion'), [55, 55]);
  assert.deepEqual(range('motorTemp'), [22, 23]);
  assert.deepEqual([...new Set(values('speedSwitch'))].sort(), [0, 1, 2]);
  assert.ok(values('brake').includes(true));
  assert.ok(values('faults').every((v) => v === 0));
});

test('commands match bytes the official app sent', () => {
  assert.equal(hex(KEEPALIVE), 'aa13ec07095f18e7');
  assert.equal(hex(buildCommand(0x13, 0x07, 0x5f, 0x5f)), 'aa13ec075f5f6e91');
  assert.equal(hex(buildCommand(0x12, 0x1b, 0xe1, 0x01)), 'aa12ed1be101a659');
  assert.equal(hex(buildCommand(0x05, 0x01, 0x5f, 0x5f)), 'aa05fa015f5f6897');
});

test('new-format frames are CRC checked', () => {
  const f = new Uint8Array(16);
  f[0] = 0xaa;
  f[1] = 0x81; // index 1 -> register 0xE8
  f[2] = 0xf4; // 756 -> 75.6 V (little-endian)
  f[3] = 0x02;
  f[6] = 0xf8; // -8 -> -2 A
  f[7] = 0xff;
  [f[14], f[15]] = crc(f, 14);
  assert.ok(frameValid(f));
  assert.deepEqual(decodeFrame(f), { voltage: 75.6, lineCurrent: -2, throttleDepth: 0 });
  f[5] ^= 1;
  assert.ok(!frameValid(f));
});

test('parser resyncs after garbage and split frames', () => {
  const a = encodeLegacyFrame(10, (f) => (f[10] = 77));
  const b = encodeLegacyFrame(4, (f) => (f[4] = 0xf0));
  const out = [];
  const p = new FrameParser((f) => out.push(decodeFrame(f)));
  p.push(Uint8Array.of(0x00, 0xaa, 0x13, 0x55));
  p.push(a.subarray(0, 9));
  p.push(Uint8Array.of(...a.subarray(9), ...b));
  assert.deepEqual(out, [{ soc: 77 }, { mosTemp: -16 }]);
});

test('demo encoder round-trips through the decoder', () => {
  const st = {
    gear: 1, speedSwitch: 2, rpm: 840, brake: true, cruise: true, boost: true, faults: 0x0041,
    voltage: 74.2, current: -12.5, modulation: 0.5, throttle: 0.5, soc: 64, motorTemp: 71, mosTemp: 48,
  };
  const p = {};
  for (const i of [0, 1, 2, 4, 10, 13, 15]) Object.assign(p, decodeFrame(encodeDemoFrame(i, st)));
  assert.equal(p.gear, 1);
  assert.equal(p.speedSwitch, 2);
  assert.equal(p.motorRpm, 840);
  assert.equal(p.brake, true);
  assert.equal(p.voltage, 74.2);
  assert.equal(p.lineCurrent, -12.5);
  assert.equal(p.soc, 64);
  assert.equal(p.motorTemp, 71);
  assert.equal(p.mosTemp, 48);
  assert.equal(p.motorStopState & 2, 2);
  assert.equal(p.global3 & 4, 4);
  assert.ok(Math.abs(p.phaseA - 25) < 0.1);
  assert.deepEqual(describeFaults(p), ['Motor hall error', 'Motor over-temp']);
});

test('fault wording depends on state bits like the official app', () => {
  assert.deepEqual(describeFaults({ faults: 1 << 4, global2: 0x8000 }), ['Over-voltage']);
  assert.deepEqual(describeFaults({ faults: 1 << 4 }), ['Under-voltage']);
  assert.deepEqual(describeFaults({ faults: 1 << 10, global1: 0x0800 }), ['Phase lost']);
  // A plain brake pull sets motorStopState bit 15 too (seen in the capture); not a fault by itself.
  assert.deepEqual(describeFaults({ faults: 0, motorStopState: 0x8000 }), []);
  assert.deepEqual(describeFaults({ faults: 2, motorStopState: 0x8000 }), ['Throttle error', 'Brake alarm']);
});
