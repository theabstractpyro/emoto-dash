// Writes the derived dash model into the DOM, touching only what changed.
import { ArcGauge } from './gauge.js';

const KM_PER_MI = 1.609344;
const $ = (id) => document.getElementById(id);

function setText(el, text) {
  if (el.textContent !== text) el.textContent = text;
}

function setAttr(el, name, value) {
  if (value == null || value === false) {
    if (el.hasAttribute(name)) el.removeAttribute(name);
  } else if (el.getAttribute(name) !== String(value)) {
    el.setAttribute(name, value === true ? '' : value);
  }
}

const fmt = (v, digits = 0) => (v == null || Number.isNaN(v) ? '–' : v.toFixed(digits));

export function formatTemp(c, unit) {
  if (c == null) return '–';
  return unit === 'F' ? `${Math.round((c * 9) / 5 + 32)}°F` : `${Math.round(c)}°C`;
}

export function formatDuration(sec) {
  const s = Math.floor(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}` : `${m}:${String(s % 60).padStart(2, '0')}`;
}

export class DashView {
  constructor() {
    this.el = {};
    for (const id of ['dash', 'speed', 'speed-unit', 'gear', 'mode', 'tt-regen', 'tt-brake', 'tt-cruise', 'tt-boost',
      'power-kw', 'current-a', 'soc', 'soc-src', 'soc-bar', 'voltage', 'cell-v', 'range', 'range-unit',
      'motor-temp', 'ctrl-temp', 'stat-motor', 'stat-ctrl', 'trip', 'trip-unit', 'eff', 'eff-label', 'ride-time',
      'banner', 'clock', 'link-ctrl', 'link-bms']) {
      this.el[id] = $(id);
    }
    this.gauge = new ArcGauge($('power-gauge'));
    this.socCells = Array.from({ length: 10 }, () => document.createElement('i'));
    this.el['soc-bar'].append(...this.socCells);
  }

  render(d, s, trip, links) {
    const e = this.el;
    const metric = s.units === 'kmh';
    const distUnit = metric ? 'km' : 'mi';
    const toDist = (km) => (metric ? km : km / KM_PER_MI);

    e.dash.classList.toggle('stale', !d.ctrlFresh);

    // Speed and drive state
    setText(e.speed, d.speedKmh == null ? '–' : String(Math.round(metric ? d.speedKmh : d.speedKmh / KM_PER_MI)));
    setText(e['speed-unit'], metric ? 'KM/H' : 'MPH');
    setText(e.gear, d.gearLabel);
    setAttr(e.gear, 'data-gear', d.gearLabel);
    const modeLabel = d.speedSwitch == null ? '–' : s[`modeLabel${Math.min(d.speedSwitch, 2)}`];
    setText(e.mode, modeLabel);
    setAttr(e.mode, 'data-off', d.gearLabel !== 'D');

    setAttr(e['tt-regen'], 'data-on', d.regenActive);
    setAttr(e['tt-regen'], 'data-armed', d.regenEnabled && !d.regenActive);
    setAttr(e['tt-brake'], 'data-on', d.brake);
    setAttr(e['tt-cruise'], 'data-on', d.cruise);
    setAttr(e['tt-boost'], 'data-on', d.boost);

    // Power
    const step = s.maxPowerKw <= 6 ? 1 : s.maxPowerKw <= 12 ? 2 : s.maxPowerKw <= 30 ? 5 : 10;
    this.gauge.setRange(-s.maxRegenKw, s.maxPowerKw, step);
    this.gauge.set(d.powerKw);
    setText(e['power-kw'], d.powerKw == null ? '–' : fmt(d.powerKw, Math.abs(d.powerKw) < 10 ? 1 : 0));
    setText(e['current-a'], fmt(d.lineCurrent, 0));

    // Battery
    setText(e.soc, fmt(d.soc, 0));
    setText(e['soc-src'], d.soc != null && d.socSource === 'bms' ? '· BMS' : '');
    const lit = d.soc == null ? 0 : Math.ceil(Math.max(0, Math.min(100, d.soc)) / 10);
    this.socCells.forEach((c, i) => setAttr(c, 'data-on', i < lit));
    setAttr(e['soc-bar'], 'data-level', d.soc == null ? null : d.soc < 8 ? 'critical' : d.soc < 15 ? 'low' : 'ok');
    setText(e.voltage, fmt(d.voltage, 1));
    setText(e['cell-v'], fmt(d.cellVoltage, 2));
    setText(e.range, d.rangeKm == null ? '–' : String(Math.round(toDist(d.rangeKm))));
    setText(e['range-unit'], distUnit);

    // Stats strip
    setText(e['motor-temp'], formatTemp(d.motorTemp, s.tempUnit));
    setText(e['ctrl-temp'], formatTemp(d.ctrlTemp, s.tempUnit));
    setAttr(e['stat-motor'], 'data-level', d.motorTempLevel);
    setAttr(e['stat-ctrl'], 'data-level', d.ctrlTempLevel);
    setText(e.trip, toDist(trip.km).toFixed(1));
    setText(e['trip-unit'], distUnit);
    setText(e['eff-label'], metric ? 'Wh/km' : 'Wh/mi');
    setText(e.eff, d.whPerKm == null ? '–' : String(Math.round(metric ? d.whPerKm : d.whPerKm * KM_PER_MI)));
    setText(e['ride-time'], formatDuration(trip.rideSec));

    // Alerts
    const top = d.alerts[0];
    e.banner.hidden = !top;
    if (top) {
      setText(e.banner, d.alerts.length > 1 ? `${top.text}  (+${d.alerts.length - 1})` : top.text);
      setAttr(e.banner, 'data-level', top.level);
    }

    // Link pills
    setAttr(e['link-ctrl'], 'data-state', links.ctrl);
    setAttr(e['link-bms'], 'data-state', links.bms);
  }

  renderClock(date, h24) {
    const h = date.getHours();
    const m = String(date.getMinutes()).padStart(2, '0');
    const html = h24
      ? `${String(h).padStart(2, '0')}:${m}`
      : `${((h + 11) % 12) + 1}:${m}<small>${h < 12 ? 'AM' : 'PM'}</small>`;
    if (this.el.clock.innerHTML !== html) this.el.clock.innerHTML = html;
  }
}
