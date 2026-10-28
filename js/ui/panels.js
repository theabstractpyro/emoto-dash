// Settings sheet (generated from SCHEMA) and the diagnostics table.
import { SCHEMA } from '../settings.js';
import { describeFaults } from '../protocol/fardriver.js';

export function buildSettingsForm(container) {
  container.replaceChildren();
  let fieldset = null;
  for (const f of SCHEMA) {
    if (!fieldset || fieldset.dataset.group !== f.group) {
      fieldset = document.createElement('fieldset');
      fieldset.dataset.group = f.group;
      const legend = document.createElement('legend');
      legend.textContent = f.group;
      fieldset.append(legend);
      container.append(fieldset);
    }
    const label = document.createElement('label');
    label.className = 'field';
    const text = document.createElement('span');
    text.textContent = f.label;
    let input;
    if (f.type === 'select') {
      input = document.createElement('select');
      for (const [value, name] of f.options) input.append(new Option(name, value));
    } else {
      input = document.createElement('input');
      input.type = f.type;
      if (f.type === 'number') {
        input.inputMode = 'decimal';
        Object.assign(input, { min: f.min, max: f.max, step: f.step });
      }
    }
    input.name = f.key;
    if (f.placeholder) input.placeholder = f.placeholder;
    const control = document.createElement('span');
    control.append(input);
    if (f.unit) {
      const u = document.createElement('span');
      u.className = 'u';
      u.textContent = f.unit;
      control.append(u);
    }
    label.append(text, control);
    fieldset.append(label);
  }
}

export function fillSettingsForm(form, settings) {
  for (const f of SCHEMA) {
    const input = form.elements[f.key];
    if (f.type === 'checkbox') input.checked = !!settings[f.key];
    else input.value = settings[f.key];
  }
}

export function readSettingsForm(form, previous) {
  const out = { ...previous };
  for (const f of SCHEMA) {
    const input = form.elements[f.key];
    if (f.type === 'checkbox') out[f.key] = input.checked;
    else if (f.type === 'number') {
      const v = parseFloat(input.value);
      out[f.key] = Number.isFinite(v) ? Math.min(f.max, Math.max(f.min, v)) : previous[f.key];
    } else out[f.key] = input.value.trim() || f.default;
  }
  return out;
}

const hex = (v) => (v == null ? '–' : `0x${v.toString(16).toUpperCase().padStart(4, '0')}`);
const num = (v, d = 1, unit = '') => (v == null ? '–' : `${v.toFixed(d)}${unit}`);

const CTRL_ROWS = [
  ['Motor speed', (c) => num(c.motorRpm, 0, ' rpm')],
  ['Battery voltage', (c) => num(c.voltage, 1, ' V')],
  ['Battery current', (c) => num(c.lineCurrent, 2, ' A')],
  ['Phase A current', (c) => num(c.phaseA, 1, ' A')],
  ['Phase C current', (c) => num(c.phaseC, 1, ' A')],
  ['Throttle voltage', (c) => num(c.throttleVoltage, 2, ' V')],
  ['Throttle depth (raw)', (c) => num(c.throttleDepth, 0)],
  ['Modulation ratio', (c) => num(c.modulation, 2)],
  ['Field weakening', (c) => (c.fieldWeakening == null ? '–' : c.fieldWeakening ? 'active' : 'MTPA')],
  ['Controller (MOSFET) temp', (c) => num(c.mosTemp, 0, ' °C')],
  ['Motor temp', (c) => num(c.motorTemp, 0, ' °C')],
  ['SOC (controller estimate)', (c) => num(c.soc, 0, ' %')],
  ['Gear / speed switch', (c) => (c.gear == null ? '–' : `${c.gear} / ${c.speedSwitch}`)],
  ['Regen (EABS) enabled', (c) => (c.eabsEnabled == null ? '–' : c.eabsEnabled ? 'yes' : 'no')],
  ['Pole pairs', (c) => num(c.polePairs, 0)],
  ['Firmware', (c) => num(c.fwVersion, 0)],
  ['Fault bits', (c) => hex(c.faults)],
  ['Faults', (c) => describeFaults(c).join(', ') || 'none'],
  ['Motor stop state', (c) => hex(c.motorStopState)],
  ['Global state 1–4', (c) => [c.global1, c.global2, c.global3, c.global4].map(hex).join(' ')],
];

export function renderDetails(table, telemetry, linkStats) {
  const c = telemetry.ctrl.values;
  const rows = [['CONTROLLER'], ...CTRL_ROWS.map(([k, fn]) => [k, fn(c)])];
  rows.push(['APP'], ['Version', linkStats.appVersion]);
  rows.push(['LINK'], ['Source', linkStats.name], ['Status', telemetry.ctrl.status],
    ['Frames / s', linkStats.fps.toFixed(1)], ['Frames total', String(linkStats.frames)],
    ['Bytes discarded', String(linkStats.dropped)], ['Connect attempts', String(linkStats.attempts)],
    ['Last link error', linkStats.lastError || 'none'], ['Reconnect method', linkStats.reconnectMethod],
    ['Auto-connect at app start', linkStats.canRestore ? 'supported' : 'needs Chrome setting (see Settings)']);
  const b = telemetry.bms.values;
  if (Object.keys(b).length) {
    rows.push(['BMS'], ...Object.entries(b).map(([k, v]) => [k, Array.isArray(v) ? v.join(', ') : String(v)]));
  }
  const html = rows
    .map((r) => (r.length === 1 ? `<tr><th colspan="2">${r[0]}</th></tr>` : `<tr><td>${r[0]}</td><td>${escapeHtml(r[1])}</td></tr>`))
    .join('');
  // Compare against what we last wrote: the parser rewrites the markup (adds <tbody>).
  if (table.lastHtml !== html) {
    table.lastHtml = html;
    table.innerHTML = html;
  }
}

const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);
