// Placeholder for a future Bluetooth BMS source.
//
// To add one, implement a class with the same shape as FardriverBle:
//   EventTarget emitting
//     'status' -> detail: 'disconnected' | 'connecting' | 'connected' | 'reconnecting'
//     'data'   -> detail: a patch object using the keys in BMS_FIELDS
//   pick() (from a user gesture), restore(), disconnect()
// and register it in main.js with `connectBms(source)`. While BMS data is fresh, the dash
// prefers it over the controller's own SOC and voltage estimates, and shows a BMS panel in
// Details. Which protocol to implement depends on the BMS brand (JBD/Xiaoxiang, JK, Daly,
// ANT, ...); each uses its own GATT service and framing.

export const BMS_FIELDS = {
  soc: '%',
  voltage: 'V, pack',
  current: 'A, + discharge / - charge',
  remainingAh: 'Ah',
  fullAh: 'Ah',
  cycles: 'count',
  cellVoltages: 'V[] per cell',
  cellMin: 'V',
  cellMax: 'V',
  temps: '°C[]',
  chargeFet: 'boolean',
  dischargeFet: 'boolean',
  balancing: 'boolean',
  protections: 'string[]',
};
