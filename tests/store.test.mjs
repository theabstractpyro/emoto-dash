import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { FrameParser, decodeFrame } from '../js/protocol/fardriver.js';
import { DEFAULTS } from '../js/settings.js';
import {
  applyPatch, createTelemetry, derive, integrateTrip, newTrip, rejectTempGlitches, rpmToKmh, shaftRpm,
} from '../js/store.js';

const CAPTURE = fileURLToPath(new URL('../../FARDRIVER REVERSE ENGINEERING/analysis/data/btsnoop_att.jsonl', import.meta.url));

test('replaying the recorded session raises no false alerts', { skip: !existsSync(CAPTURE) && 'capture not present' }, () => {
  const t = createTelemetry();
  t.ctrl.everConnected = true;
  t.ctrl.status = 'connected';
  const notifications = readFileSync(CAPTURE, 'utf8').trim().split('\n').map(JSON.parse).filter((r) => r.op === 0x1b);
  let now = 0;
  const mosTemps = new Set();
  const alerts = new Set();
  let brakeSeen = false;
  const parser = new FrameParser((f) => {
    now += 29; // ~35 frames/s, as recorded
    applyPatch(t.ctrl, rejectTempGlitches(t.ctrl, decodeFrame(f)), now);
    const d = derive(t, DEFAULTS, newTrip(), now);
    mosTemps.add(t.ctrl.values.mosTemp);
    brakeSeen ||= d.brake;
    d.alerts.forEach((a) => alerts.add(a.text));
  });
  for (const r of notifications) parser.push(Buffer.from(r.value, 'hex'));
  assert.ok(brakeSeen);
  assert.deepEqual([...alerts], []);
  assert.deepEqual([...mosTemps].filter((v) => v != null), [20]);
});

test('a temperature jump is accepted once confirmed', () => {
  const section = { values: { mosTemp: 20 } };
  assert.deepEqual(rejectTempGlitches(section, { mosTemp: 70 }), {});
  assert.deepEqual(rejectTempGlitches(section, { mosTemp: 72 }), { mosTemp: 72 });
});

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test('rpm to speed uses tire, ratio and calibration', () => {
  // 24" tire: one revolution = 1.91517 m; 840 rpm -> 96.522 km/h (59.98 mph)
  close(rpmToKmh(840, DEFAULTS), 96.5218, 1e-3);
  close(rpmToKmh(840, { ...DEFAULTS, gearRatio: 2 }), 96.5218 / 2, 1e-3);
  close(rpmToKmh(-840, { ...DEFAULTS, speedCalibration: 1.1 }), 96.5218 * 1.1, 1e-3);
});

test('shaft rpm: hub motors (16+ pole pairs) report 4-pole-pair rpm, as the official app shows', () => {
  assert.equal(shaftRpm({ motorRpm: 840, polePairs: 4 }), 840);
  assert.equal(shaftRpm({ motorRpm: 840 }), 840);
  assert.equal(shaftRpm({ motorRpm: 840, polePairs: 16 }), 210);
  assert.equal(shaftRpm({ motorRpm: -840, polePairs: 24 }), -140);
  assert.equal(shaftRpm({}), null);
  // Controller left at its factory 4 pole pairs on a 16-pole-pair hub motor: the setting wins.
  assert.equal(shaftRpm({ motorRpm: 840, polePairs: 4 }, { motorPolePairs: 16 }), 210);
  assert.equal(shaftRpm({ motorRpm: 840, polePairs: 16 }, { motorPolePairs: 0 }), 210);
  const t = createTelemetry();
  applyPatch(t.ctrl, { motorRpm: 840, polePairs: 16 }, 1000);
  const d = derive(t, DEFAULTS, newTrip(), 1000);
  assert.equal(d.motorRpm, 210);
  close(d.speedKmh, 96.5218 / 4, 1e-3);
});

test('derive: power, regen, mode flags and staleness', () => {
  const t = createTelemetry();
  applyPatch(t.ctrl, { motorRpm: 420, voltage: 75, lineCurrent: -10, eabsEnabled: true, gear: 1, speedSwitch: 1,
    motorStopState: 2, global3: 4, soc: 50, motorTemp: 105, mosTemp: 40 }, 1000);
  t.ctrl.everConnected = true;
  const d = derive(t, DEFAULTS, newTrip(), 1500);
  close(d.powerKw, -0.75);
  assert.equal(d.regenActive, true);
  assert.equal(d.cruise, true);
  assert.equal(d.boost, true);
  assert.equal(d.gearLabel, 'D');
  assert.equal(d.motorTempLevel, 'warn');
  close(d.cellVoltage, 3.75);
  // 50% of 20s 40Ah (2880 Wh) at the default 60 Wh/mi -> 24 mi
  close(d.rangeKm / 1.609344, 24, 1e-6);
  assert.deepEqual(d.alerts.map((a) => a.text), ['MOTOR HOT']);

  t.ctrl.status = 'connected';
  const stale = derive(t, DEFAULTS, newTrip(), 5000);
  assert.equal(stale.speedKmh, null);
  assert.equal(stale.alerts[0].text, 'CONTROLLER SIGNAL LOST');
  t.ctrl.status = 'reconnecting'; // key off: link dropped, app waiting for power-up
  assert.deepEqual(derive(t, DEFAULTS, newTrip(), 5000).alerts[0], { level: 'info', text: 'CONTROLLER OFF OR OUT OF RANGE' });
});

test('fresh BMS values take priority over controller estimates', () => {
  const t = createTelemetry();
  applyPatch(t.ctrl, { soc: 65, voltage: 75.6 }, 1000);
  applyPatch(t.bms, { soc: 58, voltage: 75.4 }, 1000);
  const d = derive(t, DEFAULTS, newTrip(), 1200);
  assert.equal(d.soc, 58);
  assert.equal(d.socSource, 'bms');
  assert.equal(derive(t, DEFAULTS, newTrip(), 7000).soc, null);
});

test('trip integrates distance and energy', () => {
  const trip = newTrip();
  for (let i = 0; i < 3600; i++) integrateTrip(trip, { speedKmh: 60, powerKw: 3 }, 1);
  close(trip.km, 60, 1e-6);
  close(trip.wh, 3000, 1e-6);
  assert.equal(trip.rideSec, 3600);
  integrateTrip(trip, { speedKmh: 0, powerKw: -1 }, 30); // long gaps are clamped to 1 s
  close(trip.regenWh, 1000 / 3600, 1e-9);
});
