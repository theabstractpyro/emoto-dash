import { decodeFrame } from './protocol/fardriver.js';
import { loadSettings, saveSettings } from './settings.js';
import {
  applyPatch, createTelemetry, derive, integrateTrip, loadTrip, newTrip, rejectTempGlitches, rpmToKmh, saveTrip,
} from './store.js';
import { FardriverBle } from './sources/fardriver-ble.js';
import { DemoSource } from './sources/demo.js';
import { DashView } from './ui/dash.js';
import { buildSettingsForm, fillSettingsForm, readSettingsForm, renderDetails } from './ui/panels.js';

const params = new URLSearchParams(location.search);
const $ = (id) => document.getElementById(id);

let settings = loadSettings();
let trip = loadTrip();
const telemetry = createTelemetry();
const view = new DashView();
const ble = FardriverBle.supported ? new FardriverBle(settings) : null;
let ctrlSource = null;
const linkStats = {
  name: '–', fps: 0, frames: 0, dropped: 0, attempts: 0, lastError: '', reconnectMethod: '–',
  canRestore: FardriverBle.canRestore,
};
let framesThisSecond = 0;

// ---------- Theme ----------

function applyTheme() {
  const theme = params.get('theme') || settings.theme;
  document.body.classList.toggle('theme-day', theme === 'day');
  document.body.classList.toggle('theme-night', theme !== 'day');
  document.querySelector('meta[name="theme-color"]').content = theme === 'day' ? '#f2f1ec' : '#000000';
}

// ---------- Controller source ----------

function onFrame(e) {
  applyPatch(telemetry.ctrl, rejectTempGlitches(telemetry.ctrl, decodeFrame(e.detail)), performance.now());
  framesThisSecond++;
}

function onStatus(e) {
  telemetry.ctrl.status = e.detail;
  if (e.detail === 'connected') {
    telemetry.ctrl.everConnected = true;
    $('start').hidden = true;
    keepAwake();
  }
  if (e.detail === 'disconnected') {
    showStart(telemetry.ctrl.everConnected ? 'Disconnected from the controller.' : null);
  }
}

function setCtrlSource(source) {
  if (ctrlSource && ctrlSource !== source) {
    ctrlSource.removeEventListener('frame', onFrame);
    ctrlSource.removeEventListener('status', onStatus);
    ctrlSource.disconnect();
  }
  if (ctrlSource !== source) {
    source.addEventListener('frame', onFrame);
    source.addEventListener('status', onStatus);
  }
  ctrlSource = source;
  telemetry.ctrl.values = {};
  telemetry.ctrl.at = 0;
  $('demo-tag').hidden = !(source instanceof DemoSource);
}

function startDemo() {
  const demo = new DemoSource(settings, { faults: params.has('faults') });
  setCtrlSource(demo);
  demo.start();
}

async function connectController({ showAll = false } = {}) {
  if (!ble) return;
  setCtrlSource(ble);
  $('start-msg').textContent = 'Choose your controller in the list…';
  try {
    await ble.pick({ showAll });
  } catch (err) {
    if (err.name === 'NotFoundError') {
      showStart(null); // chooser cancelled, or no matching device in range
    } else if (ble.status === 'reconnecting') {
      // Picked, but it is not answering yet (e.g. key off): the dash waits and connects on power-up.
      $('start').hidden = true;
      toast('Controller remembered. It will connect as soon as it powers on.');
    } else {
      showStart(`Could not connect: ${err.message}`);
    }
  }
}

// At launch, reattach to the remembered controller (Chrome permitting) and wait for it to power on.
async function tryRestore() {
  if (!ble) return;
  setCtrlSource(ble);
  try {
    if (await ble.restore()) {
      $('start').hidden = true;
      keepAwake();
      return;
    }
  } catch (err) {
    console.warn('Restore failed', err);
  }
  showStart(null);
}

function showStart(message) {
  $('start-msg').textContent = message || 'Connect to your Fardriver controller over Bluetooth.';
  $('start').hidden = false;
}

// Future BMS sources plug in here; see js/sources/bms.js for the contract.
export function connectBms(source) {
  telemetry.bms.status = 'connecting';
  source.addEventListener('status', (e) => (telemetry.bms.status = e.detail));
  source.addEventListener('data', (e) => applyPatch(telemetry.bms, e.detail, performance.now()));
}

// ---------- Render loop ----------

function linkState(section, fresh) {
  if (section.status === 'connected') return fresh ? 'on' : 'wait';
  if (section.status === 'connecting' || section.status === 'reconnecting') return 'wait';
  return section.status === 'absent' ? 'absent' : 'off';
}

let lastTick = performance.now();
let lastSave = 0;

function tick() {
  const now = performance.now();
  const dt = (now - lastTick) / 1000;
  lastTick = now;
  const d = derive(telemetry, settings, trip, now);
  if (d.ctrlFresh) integrateTrip(trip, d, dt);
  view.render(d, settings, trip, {
    ctrl: linkState(telemetry.ctrl, d.ctrlFresh),
    bms: linkState(telemetry.bms, d.bmsFresh),
  });
  if ($('details').open) renderDetails($('details-table'), telemetry, linkStats);
  if (now - lastSave > 5000) {
    saveTrip(trip);
    lastSave = now;
  }
}

setInterval(tick, 100);
setInterval(() => {
  linkStats.fps = framesThisSecond;
  framesThisSecond = 0;
  linkStats.name = ctrlSource?.name ?? '–';
  linkStats.frames = ctrlSource?.parser?.frames ?? 0;
  linkStats.dropped = ctrlSource?.parser?.dropped ?? 0;
  linkStats.attempts = ctrlSource?.attempts ?? 0;
  linkStats.lastError = ctrlSource?.lastError ?? '';
  linkStats.reconnectMethod = ctrlSource?.reconnectMethod ?? '–';
  view.renderClock(new Date(), settings.clock24h);
}, 1000);
view.renderClock(new Date(), settings.clock24h);

// ---------- Screen: wake lock and full screen ----------

async function keepAwake() {
  try {
    if ('wakeLock' in navigator && document.visibilityState === 'visible') await navigator.wakeLock.request('screen');
  } catch {
    // Not granted (e.g. battery saver); the screen then follows the system timeout.
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || telemetry.ctrl.status === 'disconnected') return;
  keepAwake();
  ble?.kick(); // timers may have been paused while the screen was off
});

async function toggleFullscreen() {
  try {
    if (document.fullscreenElement) {
      await document.exitFullscreen();
      return;
    }
    await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
    const type = screen.orientation?.type || '';
    await screen.orientation?.lock?.(type.startsWith('portrait') ? 'portrait' : 'landscape');
  } catch {
    // Orientation lock is optional; full screen alone is fine.
  }
}

// ---------- Toast ----------

let toastTimer;
function toast(text, ms = 3500) {
  const t = $('toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  if (ms) toastTimer = setTimeout(() => (t.hidden = true), ms);
}

// ---------- Settings ----------

buildSettingsForm($('settings-fields'));

$('btn-settings').addEventListener('click', () => {
  fillSettingsForm($('settings-form'), settings);
  $('settings').showModal();
});

function updateSettings(next) {
  settings = next;
  if (ble) ble.settings = settings;
  if (ctrlSource) ctrlSource.settings = settings;
  saveSettings(settings);
  applyTheme();
}

$('settings').addEventListener('close', () => {
  if ($('settings').returnValue !== 'save') return;
  updateSettings(readSettingsForm($('settings-form'), settings));
  if (ble?.status === 'connected') ble.startKeepAlive();
});

$('btn-reset-trip').addEventListener('click', () => {
  trip = { ...newTrip(), odoKm: trip.odoKm };
  saveTrip(trip);
  toast('Trip reset');
});

$('btn-disconnect').addEventListener('click', () => {
  $('settings').close('cancel');
  ctrlSource?.disconnect();
});

$('btn-forget').addEventListener('click', async () => {
  $('settings').close('cancel');
  await ble?.forget();
  toast('Controller forgotten');
  showStart(null);
});

$('btn-calibrate').addEventListener('click', () => {
  $('settings').close('cancel');
  calibrateWithGps();
});

// Compares GPS ground speed with the RPM-derived speed and stores the median ratio.
function calibrateWithGps() {
  if (!('geolocation' in navigator)) return toast('GPS is not available on this device');
  if (!telemetry.ctrl.at) return toast('Connect the controller first');
  const unitSpeed = settings.units === 'kmh' ? '25 km/h' : '15 mph';
  toast(`Ride at a steady speed above ${unitSpeed} for about 10 seconds…`, 0);
  const samples = [];
  const uncalibrated = { ...settings, speedCalibration: 1 };
  let watchId = null;
  const stop = (message) => {
    navigator.geolocation.clearWatch(watchId);
    clearTimeout(giveUp);
    toast(message, 6000);
  };
  const giveUp = setTimeout(() => stop('Calibration timed out. Try again at a steady speed.'), 120000);
  watchId = navigator.geolocation.watchPosition(
    (pos) => {
      const gps = pos.coords.speed;
      const rpm = telemetry.ctrl.values.motorRpm;
      if (gps == null || gps < 6.7 || !rpm || performance.now() - telemetry.ctrl.at > 1000) return;
      samples.push(gps / (rpmToKmh(rpm, uncalibrated) / 3.6));
      toast(`Calibrating… ${samples.length}/10`, 0);
      if (samples.length < 10) return;
      samples.sort((a, b) => a - b);
      const factor = Math.round(samples[5] * 1000) / 1000;
      updateSettings({ ...settings, speedCalibration: factor });
      stop(`Speed calibration set to ×${factor.toFixed(3)}`);
    },
    (err) => stop(`GPS error: ${err.message}`),
    { enableHighAccuracy: true, maximumAge: 0 },
  );
}

// ---------- Other buttons ----------

$('btn-theme').addEventListener('click', () => {
  params.delete('theme');
  updateSettings({ ...settings, theme: settings.theme === 'day' ? 'night' : 'day' });
});
$('btn-fullscreen').addEventListener('click', toggleFullscreen);
$('btn-details').addEventListener('click', () => {
  renderDetails($('details-table'), telemetry, linkStats);
  $('details').showModal();
});
$('btn-connect').addEventListener('click', () => connectController());
$('btn-connect-all').addEventListener('click', () => connectController({ showAll: true }));
$('link-ctrl').addEventListener('click', () => {
  if (ctrlSource === ble && ble?.device && ble.status !== 'disconnected') {
    if (ble.status === 'connected') $('btn-details').click();
    else {
      ble.kick();
      toast('Looking for the controller…');
    }
  } else if (!(ctrlSource instanceof DemoSource)) {
    showStart(null);
  }
});
$('btn-demo').addEventListener('click', startDemo);

// ---------- Startup ----------

applyTheme();
if (!ble) {
  $('btn-connect').disabled = true;
  $('btn-connect-all').disabled = true;
  $('bt-unsupported').hidden = false;
} else if (!FardriverBle.canRestore) {
  $('restore-hint').hidden = false;
}
if (params.has('demo')) startDemo();
else tryRestore();

if ('serviceWorker' in navigator && location.protocol.startsWith('http') && !params.has('nosw')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
