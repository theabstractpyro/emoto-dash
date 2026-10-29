// User settings: a schema drives both the defaults and the generated settings form.

const KEY = 'emoto-dash.settings';

export const SCHEMA = [
  { group: 'Speed', key: 'units', label: 'Units', type: 'select', options: [['mph', 'mph / mi'], ['kmh', 'km/h / km']], default: 'mph' },
  { group: 'Speed', key: 'tireDiameterIn', label: 'Tire outer diameter', unit: 'in', type: 'number', min: 10, max: 40, step: 0.1, default: 24 },
  { group: 'Speed', key: 'motorPolePairs', label: "Motor pole pairs (0 = use the controller's setting; QS205 V3 = 16)", type: 'number', min: 0, max: 64, step: 1, default: 0 },
  { group: 'Speed', key: 'gearRatio', label: 'Motor : wheel ratio (1 for hub motor; mid-drive: motor turns per wheel turn)', type: 'number', min: 0.5, max: 20, step: 0.01, default: 1 },
  { group: 'Speed', key: 'speedCalibration', label: 'Speed calibration factor', type: 'number', min: 0.05, max: 20, step: 0.001, default: 1 },

  { group: 'Battery', key: 'cellCount', label: 'Cells in series', type: 'number', min: 1, max: 40, step: 1, default: 20 },
  { group: 'Battery', key: 'capacityAh', label: 'Capacity', unit: 'Ah', type: 'number', min: 1, max: 500, step: 0.5, default: 40 },
  { group: 'Battery', key: 'defaultWhPerMi', label: 'Typical consumption (until trip data exists)', unit: 'Wh/mi', type: 'number', min: 10, max: 300, step: 1, default: 60 },

  { group: 'Gauges', key: 'maxPowerKw', label: 'Power gauge maximum', unit: 'kW', type: 'number', min: 1, max: 60, step: 0.5, default: 15 },
  { group: 'Gauges', key: 'maxRegenKw', label: 'Regen gauge maximum', unit: 'kW', type: 'number', min: 0.5, max: 20, step: 0.5, default: 3 },

  { group: 'Ride modes', key: 'modeLabel0', label: 'Switch position 1', type: 'text', default: 'LOW' },
  { group: 'Ride modes', key: 'modeLabel1', label: 'Switch position 2', type: 'text', default: 'MID' },
  { group: 'Ride modes', key: 'modeLabel2', label: 'Switch position 3', type: 'text', default: 'HIGH' },

  { group: 'Temperatures', key: 'tempUnit', label: 'Unit', type: 'select', options: [['F', '°F'], ['C', '°C']], default: 'F' },
  { group: 'Temperatures', key: 'motorWarnC', label: 'Motor warning', unit: '°C', type: 'number', min: 30, max: 200, step: 1, default: 100 },
  { group: 'Temperatures', key: 'motorHotC', label: 'Motor critical', unit: '°C', type: 'number', min: 30, max: 200, step: 1, default: 120 },
  { group: 'Temperatures', key: 'ctrlWarnC', label: 'Controller warning', unit: '°C', type: 'number', min: 30, max: 150, step: 1, default: 70 },
  { group: 'Temperatures', key: 'ctrlHotC', label: 'Controller critical', unit: '°C', type: 'number', min: 30, max: 150, step: 1, default: 85 },

  { group: 'Indicators', key: 'showRegen', label: 'Show REGEN light', type: 'checkbox', default: true },
  { group: 'Indicators', key: 'showBrake', label: 'Show BRAKE light', type: 'checkbox', default: true },
  { group: 'Indicators', key: 'showCruise', label: 'Show CRUISE light (needs a cruise button)', type: 'checkbox', default: false },
  { group: 'Indicators', key: 'showBoost', label: 'Show BOOST light (needs a boost button)', type: 'checkbox', default: false },

  { group: 'Display', key: 'clock24h', label: '24-hour clock', type: 'checkbox', default: false },
  { group: 'Display', key: 'theme', label: 'Theme', type: 'select', options: [['night', 'Night (dark)'], ['day', 'Day (high contrast)']], default: 'night' },

  { group: 'Connection', key: 'controllerName', label: 'Controller name starts with (blank = detect automatically)', type: 'text', default: '', placeholder: 'e.g. YuanQu' },
  { group: 'Connection', key: 'keepAlive', label: 'Send keep-alive packets (as the official app does)', type: 'checkbox', default: true },
  { group: 'Connection', key: 'autoConnectOnLaunch', label: 'Connect automatically when the app opens', type: 'checkbox', default: true },
  { group: 'Connection', key: 'autoReconnect', label: 'Reconnect automatically after the link drops (key off/on)', type: 'checkbox', default: true },
];

export const DEFAULTS = Object.fromEntries(SCHEMA.map((f) => [f.key, f.default]));

export function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || '{}');
    return { ...DEFAULTS, ...saved };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(settings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    // Storage can be unavailable (private mode); settings then last for this session only.
  }
}
