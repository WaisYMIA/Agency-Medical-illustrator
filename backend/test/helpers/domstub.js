// ============================================================
// Minimal fake DOM, just enough to run frontend/app.js under Node.
//
// It is NOT a browser — it can't test layout, CSS, or real click
// behaviour. What it does let us test is the app's LOGIC against a real
// backend: the agent gate, session handling, what gets sent to the API,
// and what happens when the API says no. That's the part that previously
// had no automated coverage at all.
// ============================================================
class FakeElement {
  constructor(tag) { this.tagName = tag; this.children = []; this.attrs = {}; this._listeners = {}; this._value = ''; this._checked = false; this.className = ''; this.parentNode = null; this.style = { setProperty(){} }; this.id = ''; }
  setAttribute(k, v) { this.attrs[k] = v; if (k === 'id') this.id = v; }
  getAttribute(k) { return this.attrs[k]; }
  appendChild(c) { if (c) { this.children.push(c); if (c instanceof FakeElement) c.parentNode = this; } return c; }
  removeChild(c) { this.children = this.children.filter(x => x !== c); }
  addEventListener(evt, fn) { this._listeners[evt] = fn; }
  set innerHTML(v) { this.children = []; } get innerHTML() { return ''; }
  set value(v) { this._value = v; } get value() { return this._value; }
  set checked(v) { this._checked = v; } get checked() { return this._checked; }
  set textContent(v) { this._text = v; } get textContent() { return this._text; }
  click() { if (this._listeners['click']) this._listeners['click']({ target: this }); }
  changeValue(v) { this._value = v; if (this._listeners['input']) this._listeners['input'](); if (this._listeners['change']) this._listeners['change'](); }
  toggle() { this._checked = !this._checked; if (this._listeners['change']) this._listeners['change'](); }
  findAll(pred, acc) { acc = acc || []; if (pred(this)) acc.push(this); this.children.forEach(c => { if (c instanceof FakeElement) c.findAll(pred, acc); }); return acc; }
  textContent_() { let t = ''; this.children.forEach(c => { if (typeof c === 'string') t += c; else if (c instanceof FakeElement) t += c.textContent_(); else if (c && c.nodeValue) t += c.nodeValue; }); if (this._text) t += this._text; return t; }
}
const idMap = {}; const bodyEl = new FakeElement('body');
global.document = {
  createElement: (t) => new FakeElement(t), createTextNode: (t) => ({ nodeValue: t }),
  getElementById: (id) => { const f = bodyEl.findAll(n => n.id === id)[0]; if (f) return f; if (!idMap[id]) idMap[id] = new FakeElement('div'); idMap[id].id = id; return idMap[id]; },
  addEventListener: () => {}, body: bodyEl, documentElement: { style: { setProperty(){} } }, title: '',
};
global.window = { scrollTo: () => {}, scrollY: 0, print: () => {} };
global.alert = () => {};
const _store = {};
global.localStorage = { getItem: k => (k in _store ? _store[k] : null), setItem: (k, v) => { _store[k] = String(v); }, removeItem: k => { delete _store[k]; } };
module.exports = { _store };
