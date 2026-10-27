// 270° arc gauge with a signed range: the value arc grows from the zero mark, rightward for
// positive values and leftward (in the regen colour) for negative ones.
const NS = 'http://www.w3.org/2000/svg';
const START = 135;
const SWEEP = 270;
const CX = 100;
const CY = 100;
const R = 82;

const polar = (r, deg) => {
  const a = (deg * Math.PI) / 180;
  return [CX + r * Math.cos(a), CY + r * Math.sin(a)];
};

function arc(r, a0, a1) {
  if (Math.abs(a1 - a0) < 0.01) return '';
  const [x0, y0] = polar(r, a0);
  const [x1, y1] = polar(r, a1);
  const large = Math.abs(a1 - a0) > 180 ? 1 : 0;
  const sweep = a1 > a0 ? 1 : 0;
  return `M${x0.toFixed(2)} ${y0.toFixed(2)}A${r} ${r} 0 ${large} ${sweep} ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

const el = (tag, attrs) => {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
};

export class ArcGauge {
  constructor(svg) {
    this.svg = svg;
    svg.setAttribute('viewBox', '0 0 200 172');
    this.min = -1;
    this.max = 1;
    this.shown = null;
  }

  angle(v) {
    const clamped = Math.max(this.min, Math.min(this.max, v));
    return START + ((clamped - this.min) / (this.max - this.min)) * SWEEP;
  }

  setRange(min, max, majorStep) {
    if (min === this.min && max === this.max) return;
    this.min = min;
    this.max = max;
    this.svg.replaceChildren();
    const zero = this.angle(0);
    this.svg.append(
      el('path', { d: arc(R, START, START + SWEEP), class: 'g-track' }),
      el('path', { d: arc(R, START, zero), class: 'g-track-regen' }),
    );
    const marks = [];
    for (let v = Math.ceil(min / majorStep) * majorStep; v <= max + 1e-9; v += majorStep) marks.push(v);
    if (min < marks[0]) marks.unshift(min); // label the regen end even when it is not a major step
    for (const v of marks) {
      const a = this.angle(v);
      const [x0, y0] = polar(R - 15, a);
      const [x1, y1] = polar(R - 8, a);
      this.svg.append(el('line', { x1: x0, y1: y0, x2: x1, y2: y1, class: v === 0 ? 'g-tick g-tick-zero' : 'g-tick' }));
      const [tx, ty] = polar(R - 27, a);
      const label = el('text', { x: tx, y: ty, class: v < 0 ? 'g-label g-label-regen' : 'g-label' });
      label.textContent = Math.abs(v);
      this.svg.append(label);
    }
    this.valuePath = el('path', { d: '', class: 'g-value' });
    this.svg.append(this.valuePath);
    this.shown = null;
  }

  set(value) {
    const v = value == null ? 0 : value;
    const key = Math.round(v * 20);
    if (key === this.shown) return;
    this.shown = key;
    const zero = this.angle(0);
    const a = this.angle(v);
    this.valuePath.setAttribute('d', v >= 0 ? arc(R, zero, a) : arc(R, a, zero));
    this.valuePath.classList.toggle('is-regen', v < 0);
    this.valuePath.classList.toggle('is-high', v > this.max * 0.85);
  }
}
