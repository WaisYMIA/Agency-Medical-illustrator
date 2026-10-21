// ============================================================
// Medical Premium Illustrator — Application UI
// ============================================================

const PRODUCT_META = {
  JCARE: {
    key: 'JCARE', name: 'JCare', tagline: 'Family cover',
    desc: 'Principal, spouse and up to 7 children. Full suite of optional benefits including maternity, dental, optical, last expense, personal accident and Covid-19.',
    tags: ['Adults + Children', '6 plan tiers', '500K – 10M'],
  },
  JUNIOR: {
    key: 'JUNIOR', name: 'J-Junior', tagline: 'Children-only cover',
    desc: 'Cover for children as the primary insured members — no principal or spouse. Up to 7 children per policy, with inpatient, outpatient, dental, optical and Covid-19 add-ons.',
    tags: ['Children only', '6 plan tiers', '500K – 10M'],
  },
  JSENIOR: {
    key: 'JSENIOR', name: 'JSenior', tagline: 'Senior cover, 65+',
    desc: 'Purpose-built for principals and spouses aged 65–79, with an optional co-payment structure. Last expense and personal accident apply to the spouse only.',
    tags: ['Ages 65–79', '5 plan tiers', '500K – 10M'],
  },
};

const TERMS_VERSION = '1.0-2026-08-19'; // bump this if TERMS.md changes materially, to force re-acceptance
const AGENT_SESSION_KEY = 'mpi_agent_session';

const state = {
  step: 1,
  product: null,
  form: {},
  results: null,
  chosenTierIdx: null,
  loading: false,
  loadError: null,
  // Agent gate
  gate: {
    passed: false,        // true once terms accepted + phone OTP-verified on this device
    screen: 'details',    // 'details' (name + phone + terms) | 'otp' (code entry)
    agentName: '',
    agreedToTerms: false,
    phone: '',
    otp: '',
    otpSent: false,
    sending: false,
    verifying: false,
    error: null,
    devModeNotice: null,
  },
  agent: null, // { phone, agentName, agentToken, firstVerifiedAt } once verified
};

function fmtKes(n) {
  if (n === null || n === undefined || isNaN(n)) return 'Kes 0';
  return 'Kes ' + Number(n).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtKesShort(n) {
  if (n === null || n === undefined || isNaN(n)) return 'Kes 0';
  return 'Kes ' + Number(n).toLocaleString('en-KE', { maximumFractionDigits: 0 });
}
function el(tag, attrs, children) {
  const e = document.createElement(tag);
  if (attrs) for (const k in attrs) {
    if (attrs[k] === null || attrs[k] === undefined) continue;
    if (k === 'class') e.className = attrs[k];
    else if (k === 'html') e.innerHTML = attrs[k];
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), attrs[k]);
    else e.setAttribute(k, attrs[k]);
  }
  (children || []).forEach(c => { if (c) e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
  return e;
}

function root() { return document.getElementById('app-root'); }

// ---------------- Terms modal (renders embedded TERMS_TEXT — no external file needed) ----------------
function simpleMarkdownToNodes(text) {
  const nodes = [];
  const lines = text.split('\n');
  let list = null;
  function flushList() { if (list) { nodes.push(list); list = null; } }
  for (let raw of lines) {
    const line = raw.trim();
    if (!line) { flushList(); continue; }
    if (line.startsWith('# ')) { flushList(); nodes.push(el('h2', { style: 'margin-top:22px' }, [line.slice(2)])); }
    else if (line.startsWith('## ')) { flushList(); nodes.push(el('h3', { style: 'margin-top:20px; color:var(--maroon-900)' }, [line.slice(3)])); }
    else if (line.startsWith('- ')) {
      if (!list) list = el('ul', { style: 'margin:8px 0; padding-left:22px' });
      list.appendChild(el('li', { style: 'margin-bottom:4px' }, [line.slice(2).replace(/\*\*/g, '')]));
    } else if (line === '---') { flushList(); nodes.push(el('hr', { style: 'margin:18px 0; border:none; border-top:1px solid var(--line)' })); }
    else { flushList(); nodes.push(el('p', { style: 'margin:8px 0; line-height:1.6' }, [line.replace(/\*\*/g, '').replace(/\*/g, '')])); }
  }
  flushList();
  return nodes;
}

function openTermsModal() {
  const overlay = el('div', {
    style: 'position:fixed; inset:0; background:rgba(34,26,23,0.55); z-index:1000; display:flex; align-items:center; justify-content:center; padding:20px;',
    onclick: (e) => { if (e.target === overlay) closeTermsModal(); },
  });
  const box = el('div', {
    style: 'background:#fff; max-width:680px; width:100%; max-height:85vh; overflow-y:auto; border-radius:6px; padding:28px 30px; box-shadow:0 20px 60px rgba(0,0,0,0.4);',
  });
  const closeBtn = el('button', {
    type: 'button', class: 'btn btn-ghost', style: 'float:right;',
    onclick: () => closeTermsModal(),
  }, ['Close']);
  box.appendChild(closeBtn);
  simpleMarkdownToNodes(typeof TERMS_TEXT !== 'undefined' ? TERMS_TEXT : 'Terms and Conditions text is unavailable.').forEach(n => box.appendChild(n));
  overlay.appendChild(box);
  overlay.id = 'terms-modal-overlay';
  document.body.appendChild(overlay);
}

function closeTermsModal() {
  const overlay = document.getElementById('terms-modal-overlay');
  if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
}


function renderSteps() {
  const labels = ['Choose Product', 'Client Details', 'Illustration'];
  const track = el('div', { class: 'steps-track' });
  labels.forEach((label, i) => {
    const n = i + 1;
    track.appendChild(el('div', { class: 'step-chip' + (state.step === n ? ' active' : '') }, [
      el('span', { class: 'num' }, [String(n)]),
      el('span', {}, [label]),
    ]));
    if (i < labels.length - 1) track.appendChild(el('div', { class: 'step-sep' }));
  });
  return track;
}

function renderMasthead() {
  const mh = el('div', { class: 'masthead' });
  const inner = el('div', { class: 'masthead-inner' }, [
    el('div', { class: 'brand-mark' }, [
      el('div', { class: 'brand-crest' }, [BRANDING.logoInitial]),
      el('div', { class: 'brand-text' }, [
        el('h1', {}, [BRANDING.productName]),
        el('p', {}, [BRANDING.tagline]),
      ]),
    ]),
    renderSteps(),
  ]);
  mh.appendChild(inner);
  return mh;
}

// ---------------- Agent Gate: session persistence ----------------
function loadAgentSession() {
  try {
    const raw = localStorage.getItem(AGENT_SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.termsVersion !== TERMS_VERSION) return null; // terms changed — re-gate
    return parsed;
  } catch (e) {
    return null;
  }
}
function saveAgentSession(session) {
  try { localStorage.setItem(AGENT_SESSION_KEY, JSON.stringify(session)); } catch (e) { /* storage unavailable — proceed without persistence */ }
}
function clearAgentSession() {
  try { localStorage.removeItem(AGENT_SESSION_KEY); } catch (e) { /* nothing to clear */ }
}

// Called when the backend says this agent's session is no longer valid
// (for example, an admin revoked their access). Drops the saved session
// and puts them back at the terms + OTP gate with an explanation.
function endSessionAndReturnToGate(message) {
  clearAgentSession();
  state.agent = null;
  state.gate.passed = false;
  state.gate.screen = 'details';
  state.gate.otpSent = false;
  state.gate.otp = '';
  // A returning agent must tick the Terms box afresh. Every acceptance is
  // recorded as an audit entry, so it has to be a deliberate act each
  // time — not a box left pre-ticked from their previous visit.
  state.gate.agreedToTerms = false;
  state.gate.error = message || 'Your session has ended. Please verify your phone number again.';
  state.loading = false;
  state.results = null;
  state.step = 1;
  render();
}

// On startup, quietly confirm a saved session is still valid with the
// backend. If the agent was revoked while the app was closed, they see
// the gate straight away instead of discovering it after filling in a
// whole form. A network failure is deliberately NOT treated as
// "invalid" — a flaky connection shouldn't lock a legitimate agent out.
async function validateSavedSession() {
  if (!state.agent || !state.agent.agentToken) return;
  try {
    const res = await fetch(API_BASE_URL + '/api/agent/session?agentToken=' + encodeURIComponent(state.agent.agentToken));
    if (res.status === 404) {
      endSessionAndReturnToGate('Your access has been removed. Please verify your phone number again to continue.');
    }
  } catch (e) {
    // Offline or backend unreachable — keep the saved session and carry on.
  }
}

async function requestOtp() {
  const g = state.gate;
  if (!g.agentName || !g.agentName.trim()) { g.error = 'Enter your full name.'; render(); return; }
  if (!g.agreedToTerms) { g.error = 'You must agree to the Terms and Conditions to continue.'; render(); return; }
  const phoneClean = (g.phone || '').replace(/[\s-]/g, '');
  if (!/^(0|\+?254)7\d{8}$/.test(phoneClean) && !/^(0|\+?254)1\d{8}$/.test(phoneClean)) {
    g.error = 'Enter a valid phone number, e.g. 07XXXXXXXX.';
    render();
    return;
  }
  g.sending = true; g.error = null; g.devModeNotice = null;
  render();
  try {
    const res = await fetch(API_BASE_URL + '/api/agent/request-otp', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: phoneClean }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Could not send the OTP.');
    g.otpSent = true;
    g.sending = false;
    g.screen = 'otp';
    if (data.devMode) g.devModeNotice = 'No SMS provider is configured yet — the verification code was written to the server console instead of texted to this number.';
    render();
  } catch (err) {
    g.sending = false;
    g.error = 'Could not reach the server to send an OTP. Check your connection and try again. (' + err.message + ')';
    render();
  }
}

async function verifyOtpAndProceed() {
  const g = state.gate;
  if (!g.otp || g.otp.length < 4) { g.error = 'Enter the code you received.'; render(); return; }
  g.verifying = true; g.error = null;
  render();
  const phoneClean = (g.phone || '').replace(/[\s-]/g, '');
  try {
    const verifyRes = await fetch(API_BASE_URL + '/api/agent/verify-otp', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: phoneClean, otp: g.otp, agentName: g.agentName }),
    });
    const verifyData = await verifyRes.json().catch(() => ({}));
    if (!verifyRes.ok) throw new Error(verifyData.error || 'Verification failed.');

    const agent = verifyData.agent;

    const acceptRes = await fetch(API_BASE_URL + '/api/agent/accept-terms', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentToken: agent.agentToken, phone: agent.phone, agentName: agent.agentName, termsVersion: TERMS_VERSION }),
    });
    const acceptData = await acceptRes.json().catch(() => ({}));
    if (!acceptRes.ok) throw new Error(acceptData.error || 'Could not record terms acceptance.');

    const session = {
      phone: agent.phone,
      agentName: agent.agentName,
      agentToken: agent.agentToken,
      firstVerifiedAt: agent.firstVerifiedAt,
      termsAcceptedAt: acceptData.acceptance.acceptedAt,
      termsVersion: TERMS_VERSION,
    };
    saveAgentSession(session);
    state.agent = session;
    state.gate.passed = true;
    g.verifying = false;
    render();
  } catch (err) {
    g.verifying = false;
    g.error = 'Verification failed. Check the code and try again. (' + err.message + ')';
    render();
  }
}

function renderGate() {
  const g = state.gate;
  const panel = el('div', { class: 'panel' });
  panel.appendChild(el('div', { class: 'panel-head' }, [
    el('h2', {}, [g.screen === 'details' ? 'Agent Acknowledgement' : 'Verify Your Phone Number']),
    el('span', { class: 'product-pill' }, ['Step ' + (g.screen === 'details' ? '1' : '2') + ' of 2']),
  ]));
  const body = el('div', { class: 'panel-body' });

  if (g.screen === 'details') {
    body.appendChild(el('p', { class: 'section-sub' }, [
      'This system has not yet been authorised for use by the company. Before continuing, please enter your details and confirm your acceptance of the Terms and Conditions below. This is required the first time you use this system on this device — after that, it will remember you.',
    ]));
    const grid = el('div', { class: 'field-grid' });
    grid.appendChild(field('Your Full Name', null, textInput(g.agentName, v => { g.agentName = v; }, 'Full name')));
    grid.appendChild(field('Phone Number', 'For your one-time verification code', textInput(g.phone, v => { g.phone = v; }, 'e.g. 0712345678')));
    body.appendChild(grid);

    body.appendChild(el('p', { style: 'margin-top:16px' }, [
      el('button', {
        type: 'button',
        style: 'color:var(--red-600); font-weight:600; background:none; border:none; padding:0; font-size:inherit; font-family:inherit; cursor:pointer; text-decoration:underline;',
        onclick: () => { openTermsModal(); },
      }, ['Read the full Terms and Conditions of Use ↗']),
    ]));

    const checkWrap = el('label', { style: 'display:flex; gap:10px; align-items:flex-start; margin-top:14px; cursor:pointer; font-size:13.5px; color:var(--ink-700)' });
    const checkbox = el('input', { type: 'checkbox' });
    checkbox.checked = g.agreedToTerms;
    checkbox.addEventListener('change', () => { g.agreedToTerms = checkbox.checked; render(); });
    checkWrap.appendChild(checkbox);
    checkWrap.appendChild(el('span', {}, [
      'I confirm that I have read and agree to the Terms and Conditions of Use, and I understand that I am personally responsible for how I use this system and any illustrations it produces, including sharing them with clients.',
    ]));
    body.appendChild(checkWrap);

    if (g.error) body.appendChild(el('div', { class: 'notice warn', style: 'margin-top:16px' }, [g.error]));

    panel.appendChild(body);
    const canContinue = g.agentName && g.agentName.trim() && g.agreedToTerms && g.phone && g.phone.trim();
    panel.appendChild(el('div', { class: 'form-actions', style: 'justify-content:flex-end' }, [
      el('button', {
        class: 'btn btn-primary',
        disabled: (canContinue && !g.sending) ? null : 'disabled',
        onclick: () => { if (!g.sending) requestOtp(); },
      }, [g.sending ? 'Sending…' : 'Send Verification Code →']),
    ]));
    return panel;
  }

  // OTP screen — name, phone, and terms are already collected; this is code entry only.
  body.appendChild(el('p', { class: 'section-sub' }, [
    'A verification code has been sent to ' + g.phone + '.',
  ]));
  if (g.devModeNotice) body.appendChild(el('div', { class: 'notice info', style: 'margin-top:14px' }, [g.devModeNotice]));
  const otpGrid = el('div', { class: 'field-grid', style: 'margin-top:14px' });
  otpGrid.appendChild(field('Verification Code', 'Check your SMS', numberInput(g.otp, v => { g.otp = String(v); }, 0, 999999)));
  body.appendChild(otpGrid);
  body.appendChild(el('div', { class: 'form-actions', style: 'padding:16px 0 0; border:none; background:transparent' }, [
    el('button', { class: 'btn btn-ghost', onclick: () => { g.screen = 'details'; g.otpSent = false; g.otp = ''; g.error = null; render(); } }, ['Change Number']),
    el('button', {
      class: 'btn btn-primary', disabled: g.verifying ? 'disabled' : null,
      onclick: () => { if (!g.verifying) verifyOtpAndProceed(); },
    }, [g.verifying ? 'Verifying…' : 'Verify & Continue']),
  ]));
  body.appendChild(el('button', {
    class: 'btn btn-ghost', style: 'margin-top:10px; font-size:12px;',
    onclick: () => { if (!g.sending) requestOtp(); },
  }, ['Resend code']));

  if (g.error) body.appendChild(el('div', { class: 'notice warn', style: 'margin-top:16px' }, [g.error]));

  panel.appendChild(body);
  return panel;
}

// ---------------- STEP 1: Product picker ----------------
function renderStep1() {
  const wrap = el('div', {});
  wrap.appendChild(el('h2', { class: 'intro-line' }, ['Select a medical cover product']));
  wrap.appendChild(el('p', { class: 'intro-sub' }, ['Each product is priced from its own independent rate table. Choose the plan that matches your client, then complete their details on the next step.']));
  const grid = el('div', { class: 'product-grid' });
  ['JCARE', 'JUNIOR', 'JSENIOR'].forEach(key => {
    const m = PRODUCT_META[key];
    const card = el('button', {
      class: 'product-card', type: 'button',
      onclick: () => { state.product = key; state.form = defaultFormFor(key); state.step = 2; render(); }
    }, [
      el('div', { class: 'product-eyebrow' }, [m.tagline]),
      el('h3', {}, [m.name]),
      el('p', {}, [m.desc]),
      el('div', { class: 'product-meta' }, m.tags.map(t => el('span', { class: 'tag' }, [t]))),
      el('div', { class: 'product-cta' }, ['Start a quote  →']),
    ]);
    grid.appendChild(card);
  });
  wrap.appendChild(grid);
  return wrap;
}

function defaultFormFor(key) {
  if (key === 'JCARE') {
    return { clientName: '', agentName: '', principalAge: '', hasSpouse: false, spouseAge: '',
      numChildren: 0, tierIdx: 0, outpatient: 'person', maternity: false, dental: false,
      lastExpense: false, personalAccident: false, covid: false, covidLimit: null };
  }
  if (key === 'JUNIOR') {
    return { clientName: '', agentName: '', principalAge: '', numChildren: 1, tierIdx: 0, outpatient: false,
      dental: false, covid: false, covidLimit: null };
  }
  return { clientName: '', agentName: '', principalAge: '', coPayment: true, hasSpouse: false,
    spouseAge: '', numChildren: 0, tierIdx: 0, outpatient: false, dental: false,
    lastExpense: false, personalAccident: false, covid: false, covidLimit: null };
}

// ---------------- STEP 2: Form ----------------
function field(label, hint, inputEl) {
  const f = el('div', { class: 'field' });
  f.appendChild(el('label', {}, [label, hint ? el('span', { class: 'hint' }, [' — ' + hint]) : null]));
  f.appendChild(inputEl);
  return f;
}

function toggleRow(title, hint, checked, onChange) {
  const input = el('input', { type: 'checkbox' });
  input.checked = checked;
  input.addEventListener('change', () => onChange(input.checked));
  const sw = el('label', { class: 'switch' }, [input, el('span', { class: 'slider' })]);
  return el('div', { class: 'field-toggle' }, [
    el('div', { class: 'label-block' }, [
      el('span', { class: 'title' }, [title]),
      hint ? el('span', { class: 'hint' }, [hint]) : null,
    ]),
    sw,
  ]);
}

function textInput(value, onInput, placeholder) {
  const i = el('input', { type: 'text', placeholder: placeholder || '' });
  i.value = value || '';
  i.addEventListener('input', () => onInput(i.value));
  return i;
}
function numberInput(value, onInput, min, max) {
  const i = el('input', { type: 'number', min: min, max: max });
  i.value = value === '' ? '' : value;
  i.addEventListener('input', () => onInput(i.value === '' ? '' : Number(i.value)));
  return i;
}

// Age field with inline validation shown as soon as the user leaves the field
// (on blur), not just when they click Generate. Typing itself never triggers
// a re-render, so the input never loses focus mid-keystroke.
function ageField(label, hintText, value, onInput, min, max) {
  const wrap = el('div', { class: 'field' });
  wrap.appendChild(el('label', {}, [label, el('span', { class: 'hint' }, [' — ' + hintText])]));
  const input = el('input', { type: 'number', min: min, max: max });
  input.value = value === '' ? '' : value;
  const errorSlot = el('div', { class: 'notice warn', style: 'margin-top:6px; padding:6px 10px; font-size:11.5px; display:none;' });
  function validate() {
    const raw = input.value;
    if (raw === '') {
      errorSlot.children = [];
      errorSlot.setAttribute('style', 'margin-top:6px; padding:6px 10px; font-size:11.5px; display:none;');
      return;
    }
    const num = Number(raw);
    if (num < min || num > max) {
      errorSlot.children = [];
      errorSlot.appendChild(document.createTextNode(`Must be between ${min} and ${max} — this product does not cover age ${num}.`));
      errorSlot.setAttribute('style', 'margin-top:6px; padding:6px 10px; font-size:11.5px; display:block;');
    } else {
      errorSlot.children = [];
      errorSlot.setAttribute('style', 'margin-top:6px; padding:6px 10px; font-size:11.5px; display:none;');
    }
  }
  input.addEventListener('input', () => { onInput(input.value === '' ? '' : Number(input.value)); });
  input.addEventListener('blur', () => { validate(); render(); });
  wrap.appendChild(input);
  wrap.appendChild(errorSlot);
  // Re-validate immediately on render too, so a value set programmatically (or left invalid from a prior visit) still shows the warning
  if (value !== '' && value !== null && value !== undefined && (value < min || value > max)) {
    errorSlot.children = [];
    errorSlot.appendChild(document.createTextNode(`Must be between ${min} and ${max} — this product does not cover age ${value}.`));
    errorSlot.setAttribute('style', 'margin-top:6px; padding:6px 10px; font-size:11.5px; display:block;');
  }
  return wrap;
}
function selectInput(options, value, onChange) {
  const s = el('select', {});
  options.forEach(o => {
    const opt = el('option', { value: o.value }, [o.label]);
    if (String(o.value) === String(value)) opt.setAttribute('selected', 'selected');
    s.appendChild(opt);
  });
  s.addEventListener('change', () => onChange(s.value));
  return s;
}

function tierPicker(tiers, selectedIdx, onSelect) {
  const grid = el('div', { class: 'tier-grid' });
  tiers.forEach((t, i) => {
    const opt = el('button', {
      class: 'tier-option' + (i === selectedIdx ? ' selected' : ''), type: 'button',
      onclick: () => onSelect(i),
    }, [
      el('div', { class: 'tier-name' }, [t.label]),
      el('div', { class: 'tier-limit' }, [fmtKesShort(t.limit)]),
    ]);
    grid.appendChild(opt);
  });
  return grid;
}

function radioPills(options, value, onSelect, disabledSet, onDisabledClick) {
  const row = el('div', { class: 'radio-row' });
  options.forEach(o => {
    const isDisabled = disabledSet && disabledSet.has(o.value);
    const pill = el('button', {
      class: 'radio-pill' + (value === o.value ? ' selected' : '') + (isDisabled ? ' disabled' : ''),
      type: 'button',
      onclick: () => { if (!isDisabled) onSelect(o.value); else if (onDisabledClick) onDisabledClick(o.value); },
    }, [o.label]);
    row.appendChild(pill);
  });
  return row;
}

function renderStep2() {
  const m = PRODUCT_META[state.product];
  const panel = el('div', { class: 'panel' });
  panel.appendChild(el('div', { class: 'panel-head' }, [
    el('h2', {}, ['Client & Cover Details']),
    el('span', { class: 'product-pill' }, [m.name]),
  ]));
  const body = el('div', { class: 'panel-body' });

  // --- Client section ---
  const clientSection = el('div', { class: 'form-section' });
  clientSection.appendChild(el('div', { class: 'form-section-title' }, ['Client Information']));
  const clientGrid = el('div', { class: 'field-grid' });
  clientGrid.appendChild(field('Client Name', null, textInput(state.form.clientName, v => state.form.clientName = v, 'Full name')));
  clientSection.appendChild(clientGrid);
  if (state.agent) {
    clientSection.appendChild(el('p', { style: 'margin-top:10px; font-size:11px; color:var(--ink-500);' }, [
      'Agent: ' + state.agent.agentName + ' (verified ' + state.agent.phone + ')',
    ]));
  }
  body.appendChild(clientSection);

  if (state.product === 'JCARE') body.appendChild(renderJCareFields());
  if (state.product === 'JUNIOR') body.appendChild(renderJuniorFields());
  if (state.product === 'JSENIOR') body.appendChild(renderJSeniorFields());

  if (state.loadError) {
    body.appendChild(el('div', { class: 'notice warn', style: 'margin-top:20px' }, [state.loadError]));
  }

  panel.appendChild(body);

  const actions = el('div', { class: 'form-actions' }, [
    el('button', { class: 'btn btn-ghost', onclick: () => { state.step = 1; render(); }, disabled: state.loading ? 'disabled' : null }, ['← Back']),
    el('button', {
      class: 'btn btn-primary',
      onclick: () => { if (!state.loading) tryGenerate(); },
      disabled: state.loading ? 'disabled' : null,
    }, [state.loading ? 'Calculating…' : 'Generate Illustration →']),
  ]);
  panel.appendChild(actions);
  return panel;
}

function renderJCareFields() {
  const wrap = el('div', {});
  const D = state.form;
  const tiers = META.JCARE.tiers;

  const famSection = el('div', { class: 'form-section' });
  famSection.appendChild(el('div', { class: 'form-section-title' }, ['Family Composition']));
  const grid = el('div', { class: 'field-grid' });
  grid.appendChild(ageField("Principal's Age", '18–64', D.principalAge, v => D.principalAge = v, 18, 64));
  grid.appendChild(field('Number of Children', '0–7', numberInput(D.numChildren, v => D.numChildren = v, 0, 7)));
  famSection.appendChild(grid);
  famSection.appendChild(toggleRow('Include Spouse', 'Adds spouse as a covered member', D.hasSpouse, v => { D.hasSpouse = v; render(); }));
  if (D.hasSpouse) {
    const sGrid = el('div', { class: 'field-grid' });
    sGrid.appendChild(ageField("Spouse's Age", '18–64', D.spouseAge, v => D.spouseAge = v, 18, 64));
    famSection.appendChild(sGrid);
  }
  wrap.appendChild(famSection);

  const planSection = el('div', { class: 'form-section' });
  planSection.appendChild(el('div', { class: 'form-section-title' }, ['Plan Limit']));
  planSection.appendChild(tierPicker(tiers, D.tierIdx, i => {
    D.tierIdx = i;
    const eligible = tiers[i].id === 'royal' || tiers[i].id === 'prestige';
    if (D.outpatient === 'shared' && !eligible) D.outpatient = 'person';
    D._sharedLimitAttempted = false;
    render();
  }));
  wrap.appendChild(planSection);

  const benSection = el('div', { class: 'form-section' });
  benSection.appendChild(el('div', { class: 'form-section-title' }, ['Benefits']));
  benSection.appendChild(toggleRow('Outpatient', 'Enable outpatient cover', D.outpatient !== 'no', v => { D.outpatient = v ? 'person' : 'no'; render(); }));
  if (D.outpatient !== 'no') {
    const outLimit = tiers[D.tierIdx].id === 'royal' || tiers[D.tierIdx].id === 'prestige';
    const modeRow = el('div', { class: 'field', style: 'margin-top:10px' });
    modeRow.appendChild(el('label', {}, ['Outpatient Limit Type']));
    modeRow.appendChild(radioPills([
      { value: 'person', label: 'Per Person' },
      { value: 'shared', label: 'Shared Family Limit' },
    ], D.outpatient, v => { D.outpatient = v; render(); },
      outLimit ? null : new Set(['shared']),
      () => { D._sharedLimitAttempted = true; render(); }));
    if (!outLimit && D._sharedLimitAttempted) {
      modeRow.appendChild(el('div', { class: 'notice info' }, ['A shared family limit is only available on the Royal and Prestige tiers, so it isn\'t offered on the current tier — outpatient is priced per person here.']));
    }
    benSection.appendChild(modeRow);
  }
  benSection.appendChild(toggleRow('Maternity', 'Once per family, if principal or spouse covered', D.maternity, v => { D.maternity = v; render(); }));
  benSection.appendChild(toggleRow('Dental & Optical', 'Priced together, per covered member', D.dental, v => { D.dental = v; render(); }));
  benSection.appendChild(toggleRow('Last Expense', 'Spouse and each child — not the principal', D.lastExpense, v => { D.lastExpense = v; render(); }));
  benSection.appendChild(toggleRow('Personal Accident', 'Spouse only — not the principal or children', D.personalAccident, v => { D.personalAccident = v; render(); }));
  benSection.appendChild(toggleRow('Covid-19 Cover', 'Per covered member', D.covid, v => { D.covid = v; if (v && !D.covidLimit) D.covidLimit = META.JCARE.covidLimits[0]; render(); }));
  if (D.covid) {
    const cRow = el('div', { class: 'field', style: 'margin-top:10px' });
    cRow.appendChild(el('label', {}, ['Covid-19 Limit']));
    cRow.appendChild(radioPills(META.JCARE.covidLimits.map(l => ({ value: l, label: fmtKesShort(l) })), D.covidLimit, v => { D.covidLimit = Number(v); render(); }));
    benSection.appendChild(cRow);
  }
  wrap.appendChild(benSection);
  return wrap;
}

function renderJuniorFields() {
  const wrap = el('div', {});
  const D = state.form;
  const tiers = META.JUNIOR.tiers;

  const famSection = el('div', { class: 'form-section' });
  famSection.appendChild(el('div', { class: 'form-section-title' }, ['Children Covered']));
  const grid = el('div', { class: 'field-grid' });
  grid.appendChild(field("Principal's Age", '0–64, for reference — does not affect premium', numberInput(D.principalAge, v => D.principalAge = v, 0, 64)));
  grid.appendChild(field('Number of Children', '1–7', numberInput(D.numChildren, v => D.numChildren = v, 1, 7)));
  famSection.appendChild(grid);
  wrap.appendChild(famSection);

  const planSection = el('div', { class: 'form-section' });
  planSection.appendChild(el('div', { class: 'form-section-title' }, ['Plan Limit']));
  planSection.appendChild(tierPicker(tiers, D.tierIdx, i => { D.tierIdx = i; render(); }));
  wrap.appendChild(planSection);

  const benSection = el('div', { class: 'form-section' });
  benSection.appendChild(el('div', { class: 'form-section-title' }, ['Benefits']));
  benSection.appendChild(toggleRow('Outpatient', 'Per child', D.outpatient, v => { D.outpatient = v; render(); }));
  benSection.appendChild(toggleRow('Dental & Optical', 'Priced together, per child', D.dental, v => { D.dental = v; render(); }));
  benSection.appendChild(toggleRow('Covid-19 Cover', 'Per child', D.covid, v => { D.covid = v; if (v && !D.covidLimit) D.covidLimit = META.JUNIOR.covidLimits[0]; render(); }));
  if (D.covid) {
    const cRow = el('div', { class: 'field', style: 'margin-top:10px' });
    cRow.appendChild(el('label', {}, ['Covid-19 Limit']));
    cRow.appendChild(radioPills(META.JUNIOR.covidLimits.map(l => ({ value: l, label: fmtKesShort(l) })), D.covidLimit, v => { D.covidLimit = Number(v); render(); }));
    benSection.appendChild(cRow);
  }
  wrap.appendChild(benSection);
  return wrap;
}

function renderJSeniorFields() {
  const wrap = el('div', {});
  const D = state.form;
  const tiers = META.JSENIOR.tiers;

  const famSection = el('div', { class: 'form-section' });
  famSection.appendChild(el('div', { class: 'form-section-title' }, ['Family Composition']));
  const grid = el('div', { class: 'field-grid' });
  grid.appendChild(ageField("Principal's Age", '65–79', D.principalAge, v => D.principalAge = v, 65, 79));
  grid.appendChild(field('Number of Children', '0–7 (optional)', numberInput(D.numChildren, v => D.numChildren = v, 0, 7)));
  famSection.appendChild(grid);
  famSection.appendChild(toggleRow('Co-Payment', 'Off (No) applies a 10% loading to all rates', D.coPayment, v => { D.coPayment = v; render(); }));
  famSection.appendChild(toggleRow('Include Spouse', 'Adds spouse as a covered member', D.hasSpouse, v => { D.hasSpouse = v; render(); }));
  if (D.hasSpouse) {
    const sGrid = el('div', { class: 'field-grid' });
    sGrid.appendChild(ageField("Spouse's Age", '65–79', D.spouseAge, v => D.spouseAge = v, 65, 79));
    famSection.appendChild(sGrid);
  }
  wrap.appendChild(famSection);

  const planSection = el('div', { class: 'form-section' });
  planSection.appendChild(el('div', { class: 'form-section-title' }, ['Plan Limit']));
  planSection.appendChild(tierPicker(tiers, D.tierIdx, i => { D.tierIdx = i; render(); }));
  wrap.appendChild(planSection);

  const benSection = el('div', { class: 'form-section' });
  benSection.appendChild(el('div', { class: 'form-section-title' }, ['Benefits']));
  benSection.appendChild(toggleRow('Outpatient', 'Per covered member, based on own age', D.outpatient, v => { D.outpatient = v; render(); }));
  benSection.appendChild(toggleRow('Dental & Optical', 'Priced together, per covered member', D.dental, v => { D.dental = v; render(); }));
  benSection.appendChild(toggleRow('Last Expense', 'Spouse only', D.lastExpense, v => { D.lastExpense = v; render(); }));
  benSection.appendChild(toggleRow('Personal Accident', 'Spouse only', D.personalAccident, v => { D.personalAccident = v; render(); }));
  benSection.appendChild(toggleRow('Covid-19 Cover', 'Per covered member', D.covid, v => { D.covid = v; if (v && !D.covidLimit) D.covidLimit = META.JSENIOR.covidLimits[0]; render(); }));
  if (D.covid) {
    const cRow = el('div', { class: 'field', style: 'margin-top:10px' });
    cRow.appendChild(el('label', {}, ['Covid-19 Limit']));
    cRow.appendChild(radioPills(META.JSENIOR.covidLimits.map(l => ({ value: l, label: fmtKesShort(l) })), D.covidLimit, v => { D.covidLimit = Number(v); render(); }));
    benSection.appendChild(cRow);
  }
  wrap.appendChild(benSection);
  return wrap;
}

// ---------------- Validation + Generate ----------------
async function tryGenerate() {
  const D = state.form;
  const errs = [];
  if (!D.clientName || !D.clientName.trim()) errs.push('Client name is required.');
  if (state.product === 'JCARE' || state.product === 'JSENIOR') {
    const lo = state.product === 'JCARE' ? 18 : 65, hi = state.product === 'JCARE' ? 64 : 79;
    if (!D.principalAge || D.principalAge < lo || D.principalAge > hi) errs.push(`Principal's age must be between ${lo} and ${hi}.`);
    if (D.hasSpouse && (!D.spouseAge || D.spouseAge < lo || D.spouseAge > hi)) errs.push(`Spouse's age must be between ${lo} and ${hi}.`);
  }
  if (state.product === 'JUNIOR' && (!D.numChildren || D.numChildren < 1)) errs.push('At least 1 child is required.');
  if (state.product === 'JUNIOR' && D.principalAge !== '' && D.principalAge !== null && D.principalAge !== undefined && (D.principalAge < 0 || D.principalAge > 64)) errs.push("Principal's age must be between 0 and 64.");
  if (errs.length) { alert(errs.join('\n')); return; }

  let input;
  if (state.product === 'JCARE') {
    input = {
      principalAge: Number(D.principalAge), hasSpouse: D.hasSpouse, spouseAge: Number(D.spouseAge) || 0,
      numChildren: Number(D.numChildren) || 0, outpatient: D.outpatient, maternity: D.maternity,
      dental: D.dental, lastExpense: D.lastExpense, personalAccident: D.personalAccident,
      covid: D.covid, covidLimit: D.covidLimit,
    };
  } else if (state.product === 'JUNIOR') {
    input = {
      numChildren: Number(D.numChildren) || 0, outpatient: D.outpatient, dental: D.dental,
      covid: D.covid, covidLimit: D.covidLimit,
    };
  } else {
    input = {
      principalAge: Number(D.principalAge), coPayment: D.coPayment, hasSpouse: D.hasSpouse,
      spouseAge: Number(D.spouseAge) || 0, numChildren: Number(D.numChildren) || 0,
      outpatient: D.outpatient, dental: D.dental, lastExpense: D.lastExpense,
      personalAccident: D.personalAccident, covid: D.covid, covidLimit: D.covidLimit,
    };
  }

  state.loading = true;
  state.loadError = null;
  render();

  try {
    const res = await fetch(API_BASE_URL + '/api/calculate', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Agent-Token': (state.agent && state.agent.agentToken) || '',
      },
      body: JSON.stringify({ product: state.product, input, chosenTierIndex: D.tierIdx }),
    });
    if (res.status === 401) {
      // The server no longer recognises this agent (e.g. revoked).
      const errBody = await res.json().catch(() => ({}));
      endSessionAndReturnToGate(errBody.error);
      return;
    }
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      throw new Error(errBody.error || ('Server responded with ' + res.status));
    }
    const data = await res.json();
    state.results = data.results;
    state.chosenTierIdx = D.tierIdx;
    state.loading = false;
    state.step = 3;
    render();
  } catch (err) {
    state.loading = false;
    state.loadError = 'Could not reach the pricing server. Check your internet connection and that the backend is running, then try again. (' + err.message + ')';
    render();
  }
}

// ---------------- STEP 3: Results ----------------
function benefitColumns(product) {
  if (product === 'JCARE') return [
    { key: 'inpatient', label: 'Inpatient' }, { key: 'outpatient', label: 'Outpatient' },
    { key: 'maternity', label: 'Maternity' }, { key: 'dental', label: 'Dental' }, { key: 'optical', label: 'Optical' },
    { key: 'lastExpense', label: 'Last Exp.' }, { key: 'personalAccident', label: 'P. Accident' }, { key: 'covid', label: 'Covid-19' },
  ];
  if (product === 'JUNIOR') return [
    { key: 'inpatient', label: 'Inpatient' }, { key: 'outpatient', label: 'Outpatient' },
    { key: 'dental', label: 'Dental' }, { key: 'optical', label: 'Optical' }, { key: 'covid', label: 'Covid-19' },
  ];
  return [
    { key: 'inpatient', label: 'Inpatient' }, { key: 'outpatient', label: 'Outpatient' },
    { key: 'dental', label: 'Dental' }, { key: 'optical', label: 'Optical' },
    { key: 'lastExpense', label: 'Last Exp.' }, { key: 'personalAccident', label: 'P. Accident' }, { key: 'covid', label: 'Covid-19' },
  ];
}

function renderBreakdownTable(chosen, product) {
  const cols = benefitColumns(product);
  const wrap = el('div', { class: 'table-wrap' });
  const table = el('table', { class: 'data-table' });
  const thead = el('thead', {}, [el('tr', {}, [
    el('th', {}, ['Member']),
    ...cols.map(c => el('th', {}, [c.label])),
    el('th', {}, ['Total']),
  ])]);
  const tbody = el('tbody', {}, chosen.rows.map(r => el('tr', {}, [
    el('td', {}, [r.label]),
    ...cols.map(c => el('td', {}, [fmtKes(r[c.key] || 0)])),
    el('td', { style: 'font-weight:700' }, [fmtKes(r.total)]),
  ])));
  table.appendChild(thead);
  table.appendChild(tbody);
  wrap.appendChild(table);
  return wrap;
}

function renderComparisonTable(results, chosenIdx) {
  const wrap = el('div', { class: 'table-wrap' });
  const table = el('table', { class: 'data-table comparison-table' });
  const thead = el('thead', {}, [el('tr', {}, [
    el('th', {}, ['']),
    ...results.map((r, i) => el('th', { class: i === chosenIdx ? 'chosen' : '' }, [r.tier.label])),
  ])]);
  const rowsDef = [
    { label: 'Plan Limit', get: r => fmtKesShort(r.tier.limit) },
    { label: 'Basic Premium', get: r => fmtKes(r.basicPremium) },
    { label: 'Training Levy & PHF (0.45%)', get: r => fmtKes(r.levy) },
    { label: 'Stamp Duty', get: r => fmtKes(r.stampDuty) },
  ];
  const tbody = el('tbody', {}, rowsDef.map(rd => el('tr', {}, [
    el('td', {}, [rd.label]),
    ...results.map((r, i) => el('td', { class: i === chosenIdx ? 'chosen' : '' }, [rd.get(r)])),
  ])));
  const tfoot = el('tfoot', {}, [el('tr', {}, [
    el('td', {}, ['Total Annual Premium']),
    ...results.map((r, i) => el('td', { class: i === chosenIdx ? 'chosen' : '' }, [fmtKes(r.totalPremium)])),
  ])]);
  table.appendChild(thead); table.appendChild(tbody); table.appendChild(tfoot);
  wrap.appendChild(table);
  return wrap;
}

function renderStep3() {
  const D = state.form;
  const m = PRODUCT_META[state.product];
  const chosen = state.results[state.chosenTierIdx];
  const wrap = el('div', {});

  const displayAge = D.principalAge !== '' && D.principalAge !== undefined && D.principalAge !== null ? D.principalAge : null;

  const header = el('div', { class: 'result-header' }, [
    el('div', { class: 'result-header-left' }, [
      el('p', { class: 'result-eyebrow' }, [m.name + ' — ' + chosen.tier.label + ' Plan']),
      el('h2', { class: 'result-client-name' }, [D.clientName || 'Client']),
      el('div', { class: 'result-client-meta' }, [
        displayAge !== null ? el('span', {}, ['Age: ' + displayAge]) : null,
        (D.numChildren && D.numChildren > 0) ? el('span', {}, ['Children covered: ' + D.numChildren]) : null,
        el('span', {}, ['Plan limit: ' + fmtKesShort(chosen.tier.limit)]),
        state.agent ? el('span', {}, ['Agent: ' + state.agent.agentName]) : null,
      ]),
    ]),
    el('div', { class: 'result-premium-box' }, [
      el('p', { class: 'result-premium-label' }, ['Proposed Initial Premium']),
      el('div', { class: 'result-premium-value' }, [fmtKesShort(chosen.totalPremium)]),
      el('p', { class: 'result-premium-freq' }, ['per annum, inclusive of levy & stamp duty']),
    ]),
  ]);
  wrap.appendChild(header);

  if (chosen.sharedUnavailable) {
    wrap.appendChild(el('div', { class: 'notice warn', style: 'margin-top:16px' }, ['The shared family outpatient limit is not available on the ' + chosen.tier.label + ' tier — outpatient premium shown as Kes 0 for this plan. Select Royal or Prestige to use a shared family limit.']));
  }
  if (chosen.sharedFamilySizeUnsupported) {
    wrap.appendChild(el('div', { class: 'notice warn', style: 'margin-top:16px' }, ['No shared outpatient limit is published for this family size and age combination on the ' + chosen.tier.label + ' tier — outpatient premium shown as Kes 0. Try Per Person outpatient pricing, or a smaller family size, for this plan.']));
  }

  // Breakdown
  const sec1 = el('div', { class: 'section-block' });
  sec1.appendChild(el('h3', { class: 'section-title' }, ['Selected Plan — Cover Breakdown']));
  sec1.appendChild(el('p', { class: 'section-sub' }, ['Premium contribution by covered member, ' + chosen.tier.label + ' (' + fmtKesShort(chosen.tier.limit) + ') plan.']));
  sec1.appendChild(renderBreakdownTable(chosen, state.product));
  wrap.appendChild(sec1);

  // Summary cards
  const sec2 = el('div', { class: 'section-block' });
  sec2.appendChild(el('h3', { class: 'section-title' }, ['Premium Computation']));
  const cards = el('div', { class: 'summary-cards' }, [
    el('div', { class: 'summary-card' }, [el('div', { class: 'k' }, ['Basic Premium']), el('div', { class: 'v' }, [fmtKesShort(chosen.basicPremium)])]),
    el('div', { class: 'summary-card' }, [el('div', { class: 'k' }, ['Training Levy & PHF (0.45%)']), el('div', { class: 'v' }, [fmtKesShort(chosen.levy)])]),
    el('div', { class: 'summary-card' }, [el('div', { class: 'k' }, ['Stamp Duty']), el('div', { class: 'v' }, [fmtKesShort(chosen.stampDuty)])]),
    el('div', { class: 'summary-card total' }, [el('div', { class: 'k' }, ['Total Premium']), el('div', { class: 'v' }, [fmtKesShort(chosen.totalPremium)])]),
  ]);
  sec2.appendChild(cards);
  wrap.appendChild(sec2);

  // Comparison
  const sec3 = el('div', { class: 'section-block' });
  sec3.appendChild(el('h3', { class: 'section-title' }, ['How It Compares Across All ' + m.name + ' Plans']));
  sec3.appendChild(el('p', { class: 'section-sub' }, ['Same client and benefit selections, priced across every available plan limit. The ' + chosen.tier.label + ' plan is highlighted.']));
  sec3.appendChild(renderComparisonTable(state.results, state.chosenTierIdx));
  wrap.appendChild(sec3);

  wrap.appendChild(el('div', { class: 'disclaimer' }, ['This illustration is indicative and subject to underwriting. Rates shown are per annum in Kenya Shillings (Kes) and include the 0.45% Training Levy & Policy Holders Fund contribution and Kes 40 stamp duty. Final terms are confirmed at policy issuance.']));

  if (state.agent) {
    const acceptedDate = state.agent.termsAcceptedAt ? new Date(state.agent.termsAcceptedAt).toLocaleDateString() : '—';
    wrap.appendChild(el('p', {
      style: 'margin-top:10px; padding-top:10px; border-top:1px dashed var(--line); font-size:10.5px; color:var(--ink-500); line-height:1.6;',
    }, [
      'Generated by ' + (state.agent.agentName || '—') + ' (verified phone: ' + (state.agent.phone || '—') + ') · Terms and Conditions accepted ' + acceptedDate + '.',
    ]));
  }

  const actions = el('div', { class: 'result-actions no-print' }, [
    el('button', { class: 'btn btn-ghost', onclick: () => { state.step = 2; render(); } }, ['← Back to Edit']),
    el('div', { class: 'right' }, [
      el('button', { class: 'btn btn-ghost', onclick: () => { state.step = 1; state.product = null; state.results = null; render(); } }, ['Start New Quote']),
      el('button', { class: 'btn btn-gold', onclick: () => window.print() }, ['🖨  Print / Save as PDF']),
    ]),
  ]);
  wrap.appendChild(actions);

  return wrap;
}

let lastRenderedStep = null;

function render() {
  const r = root();
  const scrollY = window.scrollY;
  r.innerHTML = '';
  document.getElementById('masthead-slot').innerHTML = '';
  document.getElementById('masthead-slot').appendChild(renderMasthead());

  let content;
  if (!state.gate.passed) {
    content = renderGate();
  } else if (state.step === 1) content = renderStep1();
  else if (state.step === 2) content = renderStep2();
  else content = renderStep3();

  r.appendChild(content);
  const renderKey = state.gate.passed ? state.step : ('gate-' + state.gate.screen);
  if (renderKey !== lastRenderedStep) {
    window.scrollTo(0, 0);
  } else {
    window.scrollTo(0, scrollY);
  }
  lastRenderedStep = renderKey;
}

// ---------------- Branding (Phase 1 prototype — see ROADMAP.md) ----------------
// Falls back to these defaults if the backend is unreachable, so the app
// still renders sensibly rather than breaking.
let BRANDING = {
  companyName: 'Walter Jungah',
  productName: 'Medical Premium Illustrator',
  tagline: 'Instant Multi-Plan Quotations',
  logoInitial: 'M',
  colors: { primary: '#a6192e', primaryDark: '#3a0510', accent: '#b8892b' },
  contactPhone: '0798511366',
  contactEmail: 'walterjungah9@outlook.com',
};

function applyBranding() {
  document.title = BRANDING.productName;
  const root = document.documentElement;
  if (BRANDING.colors) {
    if (BRANDING.colors.primary) root.style.setProperty('--red-600', BRANDING.colors.primary);
    if (BRANDING.colors.primaryDark) root.style.setProperty('--maroon-950', BRANDING.colors.primaryDark);
    if (BRANDING.colors.accent) { root.style.setProperty('--gold-500', BRANDING.colors.accent); root.style.setProperty('--gold-400', BRANDING.colors.accent); }
  }
  const copyrightLine = document.getElementById('copyright-line-text');
  if (copyrightLine) copyrightLine.textContent = '© ' + new Date().getFullYear() + ' ' + BRANDING.companyName + '  ·  All rights reserved';
  const phoneEl = document.getElementById('footer-phone');
  if (phoneEl) phoneEl.textContent = 'Tel: ' + BRANDING.contactPhone;
  const emailEl = document.getElementById('footer-email');
  if (emailEl) emailEl.textContent = BRANDING.contactEmail;
}

async function loadBranding() {
  try {
    const res = await fetch(API_BASE_URL + '/api/branding');
    if (!res.ok) return; // keep defaults
    const data = await res.json();
    if (data.branding) BRANDING = data.branding;
  } catch (e) {
    // Backend unreachable — keep hardcoded defaults, app still works.
  }
  applyBranding();
  render();
}

function init() {
  const saved = loadAgentSession();
  if (saved) {
    state.agent = saved;
    state.gate.passed = true;
  }
  loadBranding();
  render();
  validateSavedSession();
}

document.addEventListener('DOMContentLoaded', init);

