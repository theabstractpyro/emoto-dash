// Connection event log, shown in Diagnostics. Kept across app restarts so launch-time
// reconnects can be inspected afterwards; "Copy log" puts it on the clipboard for a bug report.
const KEY = 'emoto-dash.linkLog';
const MAX_ENTRIES = 120;

let entries = [];
try {
  entries = JSON.parse(localStorage.getItem(KEY) || '[]');
} catch {
  entries = [];
}

let saveTimer = null;
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(entries));
    } catch {
      // The log is a diagnostic aid; losing it is harmless.
    }
  }, 250);
}

export function logLink(message) {
  entries.push([Date.now(), message]);
  if (entries.length > MAX_ENTRIES) entries = entries.slice(-MAX_ENTRIES);
  persist();
}

export function clearLinkLog() {
  entries = [];
  persist();
}

export function formatLinkLog() {
  return entries
    .map(([t, m]) => {
      const d = new Date(t);
      const time = d.toLocaleTimeString([], { hour12: false });
      return `${d.getMonth() + 1}/${d.getDate()} ${time}.${String(d.getMilliseconds()).padStart(3, '0')}  ${m}`;
    })
    .join('\n');
}
