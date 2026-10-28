import { decodeFrame } from './protocol/fardriver.js';
import { loadSettings, saveSettings } from './settings.js';
import {
  applyPatch, createTelemetry, derive, integrateTrip, loadTrip, newTrip, rejectTempGlitches, rpmToKmh, saveTrip,
} from './store.js';
import { FardriverBle } from './sources/fardriver-ble.js';
import { FardriverNative, isNativeApp } from './sources/fardriver-native.js';
import { DemoSource } from './sources/demo.js';
import { DashView } from './ui/dash.js';
import { APP_VERSION } from './version.js';
import { clearLinkLog, formatLinkLog, logLink } from './link-log.js';
import { buildSettingsForm, fillSettingsForm, readSettingsForm, renderDetails } from './ui/panels.js';

const params = new URLSearchParams(location.search);
const $ = (id) => document.getElementById(id);

let settings = loadSettings();
let trip = loadTrip();
const telemetry = createTelemetry();
const view = new DashView();
// In the Android app the controller is found by name with native scanning (no chooser, and
// immune to its address changing at every power-up); in a browser, Web Bluetooth is used.
const NATIVE = isNativeApp();
const ble = NATIVE ? new FardriverNative(settings) : FardriverBle.supported ? new FardriverBle(settings) : null;
const canAutoConnect = () => NATIVE || FardriverBle.canRestore;
let ctrlSource = null;
const linkStats = {
  name: '–', fps: 0, frames: 0, dropped: 0, attempts: 0, lastError: '', reconnectMethod: '–',
  canRestore: canAutoConnect(), appVersion: APP_VERSION + (NATIVE ? ' (Android app)' : ' (web)'),
};
const CHROME_FLAG_URL = 'chrome://flags/#enable-web-bluetooth-new-permissions-backend';
const APK_URL = 'https://github.com/theabstractpyro/emoto-dash/releases/latest/download/emoto-dash.apk';
const RELEASES_URL = 'https://github.com/theabstractpyro/emoto-dash/releases/latest';

// Problems only the native app can detect, with the button that fixes each one.
const NATIVE_FIXES = {
  'bluetooth-off': { label: 'Turn on Bluetooth', run: () => ble.plugin.requestEnable() },
  'location-off': { label: 'Turn on Location (Android needs it to find Bluetooth devices)', run: () => ble.plugin.openLocationSettings() },
  permission: { label: 'Allow Bluetooth access', run: () => ble.plugin.openAppSettings() },
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
  if (NATIVE) {
    if (showAll) return openChooser();
    setCtrlSource(ble);
    $('start').hidden = true;
    ble.start();
    keepAwake();
    return;
  }
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
  if (!settings.autoConnectOnLaunch) {
    logLink('Launch: auto-connect at launch is turned off in Settings');
    showStart(null);
    return;
  }
  if (NATIVE) {
    $('start').hidden = true;
    ble.start();
    keepAwake();
    return;
  }
  let result;
  try {
    result = await ble.restore();
  } catch (err) {
    logLink(`Launch: restore failed: ${err?.message || err}`);
  }
  if (result === true) {
    $('start').hidden = true;
    keepAwake();
    return;
  }
  showStart(result === 'none' || result === 'not-found'
    ? 'Pick your controller once more. With auto-connect on, Chrome remembers it from now on.'
    : null);
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
  const st = telemetry.ctrl.status;
  const waiting = ctrlSource === ble && !!ble && !d.ctrlFresh && (st === 'reconnecting' || st === 'connecting');
  const reconnectBtn = $('btn-reconnect');
  if (NATIVE) {
    // Native reconnects by itself; the button only appears when Android needs something from the rider.
    const fix = NATIVE_FIXES[ble.problem];
    reconnectBtn.hidden = !(waiting && fix);
    if (fix && reconnectBtn.textContent !== fix.label) reconnectBtn.textContent = fix.label;
  } else {
    reconnectBtn.hidden = !waiting;
  }
  if ($('details').open) {
    renderDetails($('details-table'), telemetry, linkStats);
    renderLog();
  }
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
  if (NATIVE) return; // the Android app keeps the screen on by itself
  try {
    if ('wakeLock' in navigator && document.visibilityState === 'visible') await navigator.wakeLock.request('screen');
  } catch {
    // Not granted (e.g. battery saver); the screen then follows the system timeout.
  }
}

document.addEventListener('visibilitychange', () => {
  logLink(document.visibilityState === 'visible' ? 'App in foreground' : 'App in background (timers may pause)');
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
  showAutoConnectStatus();
  fillSettingsForm($('settings-form'), settings);
  $('settings').showModal();
});

function updateSettings(next) {
  settings = next;
  if (ble) ble.settings = settings;
  telemetry.ctrl.waitText = NATIVE ? 'SEARCHING FOR CONTROLLER…' : 'CONTROLLER OFF OR OUT OF RANGE';
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
  if (NATIVE) return openChooser();
  await ble?.forget();
  toast('Controller forgotten');
  showStart(null);
});

// Android app: list nearby Bluetooth devices so a controller with an unknown name can be picked.
// The chosen name is saved, and from then on the app connects to it automatically.
async function openChooser() {
  const list = $('chooser-list');
  list.replaceChildren();
  const seen = new Map();
  $('chooser').showModal();
  const stop = await ble.chooseFromScan(({ name, rssi }) => {
    if (!name || !$('chooser').open) return;
    let item = seen.get(name);
    if (!item) {
      item = document.createElement('li');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'chooser-item';
      btn.addEventListener('click', () => {
        $('chooser').close();
        updateSettings({ ...settings, controllerName: name });
        logLink(`Controller chosen from list: "${name}"`);
        toast(`Will connect to ${name} automatically`);
        setCtrlSource(ble);
        ble.disconnect();
        $('start').hidden = true;
        ble.start();
      });
      item.append(btn);
      seen.set(name, item);
      list.append(item);
    }
    item.firstChild.textContent = `${name}   ${rssi ?? ''} dBm`;
  });
  $('chooser').addEventListener('close', () => {
    stop();
    if (ble.status === 'connected') ble.stopScan(); // the list's scan is no longer needed
    else ble.kick();
  }, { once: true });
}

$('btn-copy-flag').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(CHROME_FLAG_URL);
    toast("Copied. Paste it into Chrome's address bar.", 5000);
  } catch {
    // Clipboard blocked: select the text so a long-press copies it.
    getSelection().selectAllChildren(document.querySelector('.flag-url'));
    toast('Long-press the highlighted link and choose Copy', 5000);
  }
});

$('btn-update').addEventListener('click', () => updateApp());

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
  renderLog();
  $('details').showModal();
  $('link-log').scrollTop = $('link-log').scrollHeight;
});
$('btn-connect').addEventListener('click', () => connectController());
$('btn-reconnect').addEventListener('click', () => {
  if (NATIVE) {
    NATIVE_FIXES[ble.problem]?.run().catch?.(() => {});
    setTimeout(() => ble.kick(), 1500);
  } else {
    connectController();
  }
});
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

// ---------- Versions and updates ----------

// Drops every cached file and reloads, so the newest version is fetched from GitHub.
// The Android app instead opens the release page, where the newest APK can be installed.
async function updateApp() {
  if (NATIVE) {
    location.href = RELEASES_URL;
    return;
  }
  toast('Updating…', 0);
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    await reg?.update();
    await Promise.all((await caches.keys()).map((k) => caches.delete(k)));
  } catch {
    // A plain reload still fetches fresh files.
  }
  location.reload();
}

function showVersion() {
  $('version-start').textContent = `Version ${APP_VERSION}`;
  $('version-settings').textContent = `eMoto Dash v${APP_VERSION}`;
}

// Settings card: whether Chrome supports restoring devices, and what is remembered.
function showAutoConnectStatus() {
  $('android-app-link').hidden = NATIVE;
  if (NATIVE) {
    const status = $('autoconnect-status');
    status.textContent = '✓ Android app: connects by itself whenever the controller is powered on';
    status.toggleAttribute('data-ok', true);
    $('autoconnect-steps').hidden = true;
    const remembered = FardriverNative.rememberedName;
    const custom = settings.controllerName?.trim();
    $('autoconnect-detail').hidden = false;
    $('autoconnect-detail').innerHTML = custom
      ? `Looking for devices named <b>${custom.replace(/[<>&]/g, '')}…</b> (set under Connection).`
      : remembered
        ? `Last controller: <b>${remembered.replace(/[<>&]/g, '')}</b>. Use <b>Choose controller</b> to pick a different one.`
        : 'Looks for any Fardriver controller (names starting YuanQu or FarDriver).';
    return;
  }
  const supported = FardriverBle.canRestore;
  const remembered = FardriverBle.rememberedName;
  const status = $('autoconnect-status');
  status.textContent = supported
    ? '✓ Chrome setting is on'
    : 'Chrome setting is off: Chrome will ask you to pick the controller each time the app opens.';
  status.toggleAttribute('data-ok', supported);
  $('autoconnect-steps').hidden = supported;
  const detail = $('autoconnect-detail');
  detail.hidden = !supported;
  detail.innerHTML = !remembered
    ? 'No controller remembered yet: connect once and it will be.'
    : `Remembered controller: <b>${remembered.replace(/[<>&]/g, '')}</b>. `
      + 'If the app still opens to the Connect screen, pick it again once and check Diagnostics → Connection log.';
}

function renderLog() {
  const text = formatLinkLog() || 'No events yet.';
  const pre = $('link-log');
  if (pre.textContent !== text) {
    const atBottom = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 4;
    pre.textContent = text;
    if (atBottom) pre.scrollTop = pre.scrollHeight;
  }
}

$('btn-copy-log').addEventListener('click', async () => {
  const header = `eMoto Dash v${APP_VERSION} | ${navigator.userAgent}\n`
    + `native=${NATIVE} problem=${ble?.problem ?? '-'} canRestore=${canAutoConnect()} watchAdvertisements=${'watchAdvertisements' in (globalThis.BluetoothDevice?.prototype ?? {})} `
    + `status=${telemetry.ctrl.status} settings: autoConnectOnLaunch=${settings.autoConnectOnLaunch} autoReconnect=${settings.autoReconnect}\n\n`;
  try {
    await navigator.clipboard.writeText(header + formatLinkLog());
    toast('Log copied. Paste it into a message.', 4000);
  } catch {
    getSelection().selectAllChildren($('link-log'));
    toast('Long-press the highlighted log and choose Copy', 5000);
  }
});

$('btn-clear-log').addEventListener('click', () => {
  clearLinkLog();
  renderLog();
});

// If the page and its scripts come from different releases (a partially cached update),
// refresh once to bring everything to the same version.
function checkVersionConsistency() {
  const pageVersion = document.querySelector('meta[name="app-version"]')?.content;
  if (!pageVersion || pageVersion === APP_VERSION) return;
  let retried = false;
  try {
    retried = sessionStorage.getItem('emoto-dash.versionRetry') === pageVersion;
    sessionStorage.setItem('emoto-dash.versionRetry', pageVersion);
  } catch {
    retried = true; // cannot guard against a reload loop, so don't auto-reload
  }
  if (!retried) updateApp();
  else toast(`Update incomplete (page ${pageVersion}, scripts ${APP_VERSION}). Tap Settings → Update app.`, 8000);
}

// ---------- Startup ----------

logLink(`App opened (v${APP_VERSION}, ${NATIVE ? 'Android app' : FardriverBle.canRestore ? 'web, auto-connect supported' : 'web, auto-connect needs Chrome flag'})`);
applyTheme();
telemetry.ctrl.waitText = NATIVE ? 'SEARCHING FOR CONTROLLER…' : 'CONTROLLER OFF OR OUT OF RANGE';
if (NATIVE) {
  document.body.classList.add('native');
  $('btn-connect-all').textContent = 'Choose controller from a list';
  $('btn-forget').textContent = 'Choose controller';
}
if (!ble) {
  $('btn-connect').disabled = true;
  $('btn-connect-all').disabled = true;
  $('bt-unsupported').hidden = false;
} else if (!canAutoConnect()) {
  $('restore-hint').hidden = false;
}
if (params.has('demo')) startDemo();
else tryRestore();

showVersion();
checkVersionConsistency();

if (!NATIVE && 'serviceWorker' in navigator && location.protocol.startsWith('http') && !params.has('nosw')) {
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.register('sw.js').catch(() => {});
  // A new version took over: reload straight away unless that would interrupt a ride.
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController) return; // first install, nothing to refresh
    if (telemetry.ctrl.status === 'connected') toast('App updated. The new version loads next time you open it.', 6000);
    else location.reload();
  });
}
