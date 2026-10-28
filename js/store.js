// Telemetry from every source, plus the pure functions that turn it into what the dash shows.
import { describeFaults } from './protocol/fardriver.js';

export const CTRL_STALE_MS = 1500;
export const BMS_STALE_MS = 5000;
const KM_PER_MI = 1.609344;
const TRIP_KEY = 'emoto-dash.trip';

// Each source writes into its own section so a BMS can be added without touching the controller.
export function createTelemetry() {
  return {
    ctrl: { values: {}, at: 0, status: 'disconnected', everConnected: false },
    bms: { values: {}, at: 0, status: 'absent' },
    gps: { values: {}, at: 0 },
  };
}

export function applyPatch(section, patch, now) {
  Object.assign(section.values, patch);
  section.at = now;
}

// Temperature sensors occasionally report one-off spikes (the recorded session has two 0xF0
// MOSFET readings amid steady 20 °C), so a big jump is only accepted once the next reading
// confirms it. Temperatures arrive about once a second, so real changes are never this fast.
const TEMP_KEYS = ['mosTemp', 'motorTemp'];
const TEMP_JUMP_C = 25;

export function rejectTempGlitches(section, patch) {
  section.pendingTemps ??= {};
  for (const k of TEMP_KEYS) {
    if (!(k in patch)) continue;
    const prev = section.values[k];
    const pending = section.pendingTemps[k];
    const plausible = prev == null || Math.abs(patch[k] - prev) <= TEMP_JUMP_C;
    const confirmed = pending != null && Math.abs(patch[k] - pending) <= TEMP_JUMP_C;
    if (plausible || confirmed) {
      delete section.pendingTemps[k];
    } else {
      section.pendingTemps[k] = patch[k];
      delete patch[k];
    }
  }
  return patch;
}

export function rpmToKmh(rpm, s) {
  const circumferenceM = Math.PI * s.tireDiameterIn * 0.0254;
  return ((Math.abs(rpm) / s.gearRatio) * circumferenceM * 60 * s.speedCalibration) / 1000;
}

export const packWh = (s) => s.cellCount * 3.6 * s.capacityAh;

function tempLevel(c, warn, hot) {
  if (c == null) return 'none';
  if (c >= hot) return 'hot';
  if (c >= warn) return 'warn';
  return 'ok';
}

export function newTrip() {
  return { km: 0, wh: 0, regenWh: 0, rideSec: 0, maxKmh: 0, maxKw: 0, odoKm: 0 };
}

export function loadTrip() {
  try {
    return { ...newTrip(), ...JSON.parse(localStorage.getItem(TRIP_KEY) || '{}') };
  } catch {
    return newTrip();
  }
}

export function saveTrip(trip) {
  try {
    localStorage.setItem(TRIP_KEY, JSON.stringify(trip));
  } catch {
    // Trip data is a convenience; losing it on a storage error is acceptable.
  }
}

// Integrates distance and energy over dt seconds of fresh data.
export function integrateTrip(trip, dash, dtSec) {
  const dt = Math.min(dtSec, 1);
  if (dash.speedKmh != null) {
    const dKm = (dash.speedKmh * dt) / 3600;
    trip.km += dKm;
    trip.odoKm += dKm;
    if (dash.speedKmh > 1) trip.rideSec += dt;
    trip.maxKmh = Math.max(trip.maxKmh, dash.speedKmh);
  }
  if (dash.powerKw != null) {
    trip.wh += (dash.powerKw * 1000 * dt) / 3600;
    if (dash.powerKw < 0) trip.regenWh += (-dash.powerKw * 1000 * dt) / 3600;
    trip.maxKw = Math.max(trip.maxKw, dash.powerKw);
  }
}

// Everything the UI needs, in metric base units; formatting and unit conversion happen in the UI.
export function derive(t, s, trip, now) {
  const c = t.ctrl.values;
  const b = t.bms.values;
  const ctrlFresh = t.ctrl.at > 0 && now - t.ctrl.at < CTRL_STALE_MS;
  const bmsFresh = t.bms.at > 0 && now - t.bms.at < BMS_STALE_MS;
  const pick = (bmsKey, ctrlKey) =>
    bmsFresh && b[bmsKey] != null ? b[bmsKey] : ctrlFresh && c[ctrlKey] != null ? c[ctrlKey] : null;

  const speedKmh = ctrlFresh && c.motorRpm != null ? rpmToKmh(c.motorRpm, s) : null;
  const lineCurrent = ctrlFresh && c.lineCurrent != null ? c.lineCurrent : null;
  const powerKw = lineCurrent != null && c.voltage != null ? (c.voltage * lineCurrent) / 1000 : null;
  const voltage = pick('voltage', 'voltage');
  const soc = pick('soc', 'soc');

  const whPerKm = trip.km > 1.6 && trip.wh > 0 ? trip.wh / trip.km : s.defaultWhPerMi / KM_PER_MI;
  const rangeKm = soc != null ? ((soc / 100) * packWh(s)) / whPerKm : null;

  const gear = ctrlFresh ? c.gear : null;
  const motorTemp = ctrlFresh ? c.motorTemp ?? null : null;
  const ctrlTemp = ctrlFresh ? c.mosTemp ?? null : null;
  const faults = ctrlFresh ? describeFaults(c) : [];

  const dash = {
    ctrlFresh,
    bmsFresh,
    speedKmh,
    motorRpm: ctrlFresh ? c.motorRpm ?? null : null,
    powerKw,
    lineCurrent,
    regenEnabled: ctrlFresh && !!c.eabsEnabled,
    regenActive: lineCurrent != null && lineCurrent < -0.5,
    brake: ctrlFresh && !!c.brake,
    cruise: ctrlFresh && !!((c.motorStopState ?? 0) & 0x0002),
    boost: ctrlFresh && !!((c.global3 ?? 0) & 0x0004),
    gear,
    gearLabel: gear == null ? '–' : gear === 0 ? 'N' : gear === 2 ? 'R' : 'D',
    speedSwitch: ctrlFresh ? c.speedSwitch ?? null : null,
    soc,
    socSource: bmsFresh && b.soc != null ? 'bms' : 'ctrl',
    voltage,
    cellVoltage: voltage != null ? voltage / s.cellCount : null,
    rangeKm,
    whPerKm: trip.km > 1.6 ? whPerKm : null,
    motorTemp,
    ctrlTemp,
    motorTempLevel: tempLevel(motorTemp, s.motorWarnC, s.motorHotC),
    ctrlTempLevel: tempLevel(ctrlTemp, s.ctrlWarnC, s.ctrlHotC),
    faults,
  };
  dash.alerts = buildAlerts(t, dash);
  return dash;
}

// Highest-priority first; the banner shows the first entry.
function buildAlerts(t, d) {
  const alerts = [];
  if (d.faults.length) alerts.push({ level: 'danger', text: d.faults.join(' · ') });
  if (d.motorTempLevel === 'hot') alerts.push({ level: 'danger', text: 'MOTOR TEMP CRITICAL' });
  if (d.ctrlTempLevel === 'hot') alerts.push({ level: 'danger', text: 'CONTROLLER TEMP CRITICAL' });
  if (!d.ctrlFresh) {
    const status = t.ctrl.status;
    // Key off cuts the controller's power, so a dropped link while parked is normal: say so calmly.
    if (status === 'reconnecting' || status === 'connecting') alerts.push({ level: 'info', text: 'CONTROLLER OFF OR OUT OF RANGE' });
    else if (status === 'connected' && t.ctrl.everConnected) alerts.push({ level: 'warn', text: 'CONTROLLER SIGNAL LOST' });
  }
  if (d.soc != null && d.soc < 8) alerts.push({ level: 'danger', text: 'BATTERY CRITICAL' });
  else if (d.soc != null && d.soc < 15) alerts.push({ level: 'warn', text: 'BATTERY LOW' });
  if (d.motorTempLevel === 'warn') alerts.push({ level: 'warn', text: 'MOTOR HOT' });
  if (d.ctrlTempLevel === 'warn') alerts.push({ level: 'warn', text: 'CONTROLLER HOT' });
  return alerts;
}
