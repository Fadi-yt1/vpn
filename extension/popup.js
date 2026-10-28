import { PRESETS } from './lib/presets.js';
import { normalizeSite } from './lib/pac.js';
import { integrationCode } from './lib/integration.js';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];
const isFullPage = new URLSearchParams(location.search).has('full');
if (isFullPage) document.body.classList.add('full');

let S = null;          // last state from background
let busy = false;
let showAll = false;   // server list paging
let currentHost = '';
let intLang = 'curl';   // integration code tab
let intShow = false;   // show the password in the code
let intId = '';        // which of my proxies the code is for

async function send(type, extra = {}) {
  const res = await chrome.runtime.sendMessage({ type, ...extra });
  if (!res?.ok) throw new Error(res?.error || 'Unknown error');
  return res.data;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function serverTitle(s) {
  if (s.country && s.country !== 'Unknown') return s.country + (s.sni ? ` · ${s.sni}` : '');
  return s.name;
}
function serverSub(s) {
  if (s.free) return `Free · ${s.proto.toUpperCase()} · ${s.address}:${s.port}`;
  if (s.proxio) return `Proxio.io · ${s.proto.toUpperCase()} · ${s.address}:${s.port}`;
  if (s.custom) return `My proxy · ${s.proto.toUpperCase()} · ${s.address}:${s.port}${s.username ? ' · login' : ''}`;
  const net = s.kind === 'direct' ? 'proxy' : (s.net === 'raw' ? 'tcp' : s.net);
  const sec = s.security && s.security !== 'none' ? `+${s.security}` : '';
  return `${s.proto.toUpperCase()} · ${net}${sec} · ${s.address}:${s.port}`;
}
function pingBadge(p) {
  if (!p) return '<span class="ping">—</span>';
  if (p.ms == null) return '<span class="ping bad">offline</span>';
  const cls = p.ms < 300 ? 'good' : p.ms < 900 ? 'ok' : 'bad';
  return `<span class="ping ${cls}" title="${p.kind === 'real' ? 'Real delay through the server' : 'Rough estimate (install the helper for a real test)'}">${p.kind === 'real' ? '' : '≈'}${p.ms} ms</span>`;
}

// ---------- rendering ----------
let ipText = '';       // result of the last "check my IP", shown in the footer
let lastOn = null;

function speedInfo(ms) {
  if (ms == null) return { cls: '', bars: 0, text: 'Checking speed…' };
  if (ms < 400) return { cls: 's3', bars: 3, text: 'Optimized • Low latency' };
  if (ms < 1000) return { cls: 's2 ok', bars: 2, text: 'Good connection' };
  return { cls: 's1 bad', bars: 1, text: 'Slower connection' };
}

function render() {
  if (!S) return;
  const { prefs, status, servers, pings } = S;
  const on = prefs.enabled && status.state === 'on';
  const connecting = status.state === 'connecting' || busy;
  const fsx = S.freeStatus || {};
  const searching = fsx.state === 'testing' || fsx.state === 'loading';
  if (on !== lastOn) { ipText = ''; lastOn = on; }

  // the server in use (when on) or the chosen one
  const activeId = on ? status.servers?.[0] : (prefs.selected !== 'auto' ? prefs.selected : null);
  const active = activeId ? servers.find((s) => s.id === activeId) : null;
  const place = active && active.country !== 'Unknown' ? active.country : '';

  $('.power-wrap').classList.toggle('on', on && !connecting);
  $('.power-wrap').classList.toggle('busy', connecting);
  const pill = $('#status-pill');
  pill.className = 'pill ' + (connecting ? 'busy' : on ? 'on' : 'off');
  pill.querySelector('span').textContent = connecting ? 'Connecting' : on ? 'Protected' : 'Off';

  $('#state-text').textContent = connecting ? (searching ? 'Finding fast servers…' : 'Connecting…')
    : on ? (prefs.mode === 'targeted' ? 'Selected sites protected' : 'Protected connection') : 'Not connected';
  $('#state-sub').textContent = on
    ? [place || 'Free server', prefs.mode === 'targeted' ? `${prefs.sites.length} site${prefs.sites.length === 1 ? '' : 's'}` : 'All sites'].join(' • ')
    : connecting && fsx.state === 'testing' ? `Tested ${fsx.progress || 0}% · ${fsx.working || 0} working found`
      : fsx.state === 'loading' ? 'Finding free servers…'
        : fsx.state === 'testing' ? `Testing free servers… ${fsx.progress || 0}%`
          : servers.length ? `${servers.length} fast servers ready — tap to connect` : 'Tap to connect — free servers are found automatically';

  $('#error').classList.toggle('hidden', !status.error);
  $('#error').textContent = status.error || '';
  $('#warning').classList.toggle('hidden', !(on && status.warning));
  $('#warning').textContent = status.warning || '';

  $$('#mode button').forEach((b) => b.classList.toggle('active', b.dataset.mode === prefs.mode));

  // Protected sites (only in "Only selected sites" mode)
  const targeted = prefs.mode === 'targeted';
  $('#home-sites-section').classList.toggle('hidden', !targeted);
  const cs = $('#current-site');
  const tabSite = currentHost && prefs.sites.find((d) => currentHost === d || currentHost.endsWith('.' + d));
  cs.classList.toggle('hidden', !(targeted && currentHost && !tabSite));
  if (currentHost) {
    $('#current-host').textContent = currentHost;
    const t = $('#toggle-current');
    t.textContent = 'Protect';
    t.classList.add('primary');
  }
  const shown = prefs.sites.slice(0, 2);
  const rows = shown.map((d) => `
    <div class="site-row">
      <span class="site-badge"><svg><use href="#i-globe"/></svg></span>
      <span class="name">${esc(d)}</span>
      <button class="x" data-remove-site="${esc(d)}" title="Stop protecting ${esc(d)}">×</button>
    </div>`);
  if (!prefs.sites.length) rows.push('<button class="more-link" data-goto="sites">No sites yet — add sites to protect</button>');
  const extra = prefs.sites.length - shown.length;
  $('#manage-sites').textContent = extra > 0 ? `+${extra} more · Manage` : 'Add / manage';
  $('#home-sites').innerHTML = rows.join('');

  // Current server card
  const ms = active ? pings[active.id]?.ms : null;
  const sp = speedInfo(ms);
  const badge = $('#server-flag');
  badge.classList.toggle('auto', !active);
  if (active) badge.textContent = active.flag;
  else badge.innerHTML = '<svg class="bolt"><use href="#i-bolt"/></svg>';
  $('#server-name').textContent = active ? (place ? `${place}` : active.name) : 'Fastest available';
  $('#server-sub').textContent = active
    ? (on ? sp.text : serverSub(active))
    : `Auto · picks the fastest ${prefs.source === 'proxio' ? 'Proxio.io ' : prefs.source === 'custom' ? 'of your ' : prefs.source === 'both' ? '' : 'free '}${prefs.source === 'custom' ? 'proxies' : 'server'}${prefs.country ? ' in ' + prefs.country : ''}`;
  const sig = $('#server-ping');
  sig.classList.toggle('hidden', !(active && ms != null));
  sig.className = `signal ${sp.cls}${active && ms != null ? '' : ' hidden'}`;
  sig.querySelector('.ms').textContent = ms != null ? `${ms} ms` : '';

  // Footer
  $('#check-ip').classList.toggle('on', on);
  $('#footer-text').textContent = ipText || (on ? 'Encrypted connection · tap to check your IP' : 'Not connected · tap to check your IP');

  renderServers();
  renderSites();
  renderSettings();
}

function countries() {
  const counts = {};
  for (const s of S.servers) counts[s.country] = (counts[s.country] || 0) + 1;
  return Object.entries(counts).sort((a, b) => b[1] - a[1]);
}
function flagOf(country) { return S.servers.find((s) => s.country === country)?.flag || '🌐'; }

function fillCountrySelect(sel, value, anyLabel) {
  if (document.activeElement === sel) return; // user is choosing right now
  const list = countries();
  if (value && !list.some(([c]) => c === value)) list.push([value, 0]);
  const opts = [`<option value="">${anyLabel}</option>`, ...list.map(([c, n]) => `<option value="${esc(c)}">${flagOf(c)} ${esc(c)} (${n})</option>`)];
  const html = opts.join('');
  if (sel.dataset.html !== html) { sel.innerHTML = html; sel.dataset.html = html; }
  sel.value = value;
}

function renderServers() {
  const { prefs, servers, pings } = S;
  fillCountrySelect($('#country-filter'), $('#country-filter').value || '', 'All countries');
  const q = $('#search').value.trim().toLowerCase();
  const cf = $('#country-filter').value;
  const score = (s) => { const p = pings[s.id]; return !p ? 5e4 : p.ms == null ? 1e5 : p.ms; };
  const src = prefs.source || 'free';
  const list = servers
    .filter((s) => (src === 'custom' ? s.custom || (!s.free && !s.proxio)
      : src === 'proxio' ? !s.free && !s.custom : src === 'free' ? !s.proxio && !s.custom : !s.custom))
    .filter((s) => !cf || s.country === cf)
    .filter((s) => !q || `${s.name} ${s.address} ${s.sni} ${s.country} ${s.proto} ${s.net}`.toLowerCase().includes(q))
    .sort((a, b) => score(a) - score(b));

  const fs = S.freeStatus || {};
  const busyTest = S.testing || S.refreshing || fs.state === 'loading' || fs.state === 'testing';
  $('#test-info').textContent = fs.state === 'loading' ? 'Downloading free server lists…'
    : fs.state === 'testing' ? `Testing free servers… ${fs.progress || 0}% · ${fs.working || 0} working so far`
      : fs.error ? fs.error
        : fs.at ? `${servers.filter((s) => s.free && pings[s.id]?.ms != null).length} fast free servers ready (checked ${fs.found}). Updated ${new Date(fs.at).toLocaleTimeString()} · refreshes every 30 min.`
          : 'Free servers are being prepared…';
  $('#test').disabled = busyTest;
  $('#test').textContent = busyTest ? 'Searching…' : 'Find fastest free servers';
  if (src === 'custom') {
    const c = S.custom || {};
    const b = c.busy || c.state === 'testing';
    $('#test').disabled = b;
    $('#test').textContent = b ? 'Testing…' : 'Test my proxies again';
    $('#test-info').textContent = c.error ? c.error : c.at ? `${c.working} of ${c.total} of your proxies working · tested ${new Date(c.at).toLocaleTimeString()}` : 'Add your proxy in Settings → My proxies.';
  }
  if (src === 'proxio') {
    const px = S.proxio || {};
    const b = px.busy || px.state === 'loading' || px.state === 'testing';
    $('#test').disabled = b;
    $('#test').textContent = b ? 'Loading…' : 'Reload Proxio.io servers';
    $('#test-info').textContent = px.state === 'testing' ? `Testing ${px.fetched || ''} Proxio.io servers…`
      : px.error ? px.error
        : px.at ? `${px.working} Proxio.io servers working · updated ${new Date(px.at).toLocaleTimeString()}`
          : 'Add your Proxio.io API key in Settings.';
  }

  const limit = showAll ? list.length : 60;
  const rows = [`
    <div class="srv ${prefs.selected === 'auto' ? 'selected' : ''}" data-id="auto">
      <span class="flag auto"><svg class="bolt"><use href="#i-bolt"/></svg></span>
      <div class="info"><div class="name">Fastest available</div><div class="sub">${src === 'proxio' ? 'Fastest of your Proxio.io servers' : src === 'custom' ? 'Fastest of your own proxies' : 'Recommended — no setup, switches automatically'}</div></div>
    </div>`];
  for (const s of list.slice(0, limit)) {
    rows.push(`
    <div class="srv ${prefs.selected === s.id ? 'selected' : ''}" data-id="${s.id}" title="${esc(s.name)}">
      <span class="flag">${s.flag}</span>
      <div class="info"><div class="name">${esc(serverTitle(s))}</div><div class="sub">${esc(serverSub(s))}</div></div>
      ${pingBadge(pings[s.id])}
    </div>`);
  }
  if (list.length > limit) rows.push(`<button class="btn ghost more" id="show-all">Show all ${list.length} servers</button>`);
  if (!servers.length) rows.push('<p class="muted tiny center">Finding free servers for you… this takes about 30 seconds the first time.</p>');
  $('#server-list').innerHTML = rows.join('');

  $('#sources').innerHTML = S.sources.map((src) => `
    <div class="source">
      <div class="grow"><div class="strong">${esc(src.name)}</div>
      <div class="muted tiny">${src.count} servers · updated ${new Date(src.updatedAt).toLocaleString()}${src.type === 'url' ? ' · auto-updates' : ''}</div></div>
      <button class="btn small danger" data-remove-source="${src.id}">Remove</button>
    </div>`).join('');
}

function renderSites() {
  const { prefs } = S;
  $('#site-count').textContent = prefs.sites.length ? `(${prefs.sites.length})` : '';
  $('#site-list').innerHTML = prefs.sites.length
    ? prefs.sites.map((d) => `
      <div class="site-row">
        <span class="site-badge"><svg><use href="#i-globe"/></svg></span>
        <span class="name">${esc(d)}</span>
        <button class="x" data-remove-site="${esc(d)}" title="Remove">×</button>
      </div>`).join('')
    : '<p class="muted tiny">No sites yet. Add one above or use Quick add.</p>';
  $('#presets').innerHTML = PRESETS.map((p, i) => {
    const added = p.domains.every((d) => prefs.sites.includes(d));
    return `<button class="chip ${added ? 'added' : ''}" data-preset="${i}">${added ? '✓ ' : '+ '}${esc(p.name)}</button>`;
  }).join('');
}

function renderSettings() {
  const { prefs } = S;
  fillCountrySelect($('#home-country'), prefs.country, 'Fastest available');
  $('#auto-pool').value = String(prefs.autoPool);
  fillCountrySelect($('#auto-country'), prefs.country, 'Any country (fastest)');
  if (document.activeElement !== $('#socks-port')) $('#socks-port').value = prefs.socksPort;
  if (document.activeElement !== $('#http-port')) $('#http-port').value = prefs.httpPort;
  $('#manual-core').checked = prefs.manualCore;
  if (document.activeElement !== $('#server-source')) $('#server-source').value = prefs.source || 'free';

  renderCustom();

  // Proxio.io card
  const px = S.proxio || {};
  const keyBox = $('#proxio-key');
  if (document.activeElement !== keyBox && !keyBox.value) keyBox.placeholder = px.hasKey ? `Key saved (${px.keyHint})` : 'Paste your Proxio.io API key';
  if (document.activeElement !== $('#proxio-type')) $('#proxio-type').value = px.type || 'socks5';
  if (document.activeElement !== $('#proxio-limit')) $('#proxio-limit').value = String(px.limit || 50);
  $('#proxio-refresh').classList.toggle('hidden', !px.hasKey);
  $('#proxio-remove').classList.toggle('hidden', !px.hasKey);
  const busyP = px.busy || px.state === 'loading' || px.state === 'testing';
  $('#proxio-save').disabled = busyP;
  $('#proxio-refresh').disabled = busyP;
  $('#proxio-save').textContent = busyP ? 'Loading…' : px.hasKey ? 'Save & reload' : 'Save & load servers';
  const stEl = $('#proxio-status');
  stEl.className = 'muted tiny' + (px.error && !busyP ? ' err' : px.working ? ' ok' : '');
  stEl.textContent = px.state === 'loading' ? 'Downloading your Proxio.io servers…'
    : px.state === 'testing' ? `Testing ${px.fetched || ''} Proxio.io servers…`
      : px.error ? px.error
        : px.at ? `${px.working} of ${px.fetched} Proxio.io servers working${px.skipped ? ` (${px.skipped} password SOCKS5 skipped)` : ''} · updated ${new Date(px.at).toLocaleTimeString()}`
          : px.hasKey ? 'Key saved.' : '';
}

function renderCustom() {
  const mine = S.servers.filter((s) => s.custom);
  const c = S.custom || {};
  const busyC = c.busy || c.state === 'testing';
  $('#custom-save').disabled = busyC;
  $('#custom-save').textContent = busyC ? 'Testing…' : mine.length ? 'Add & test (replaces list)' : 'Add & test';
  $('#custom-test').classList.toggle('hidden', !mine.length);
  $('#custom-test').disabled = busyC;
  const st = $('#custom-status');
  st.className = 'muted tiny' + (c.error && !busyC ? ' err' : c.working ? ' ok' : '');
  st.textContent = busyC ? 'Testing your proxies…'
    : c.error ? c.error
      : c.at ? `${c.working} of ${c.total} working · tested ${new Date(c.at).toLocaleTimeString()}` : '';
  $('#custom-list').innerHTML = mine.map((s) => `
    <div class="srv">
      <span class="flag">${s.flag}</span>
      <div class="info"><div class="name">${esc(s.address)}:${s.port}</div><div class="sub">${esc(s.proto.toUpperCase())}${s.username ? ' · user ' + esc(s.username) : ''}${s.country !== 'Unknown' ? ' · ' + esc(s.country) : ''}</div></div>
      ${pingBadge(S.pings[s.id])}
      <button class="x" data-remove-custom="${s.id}" title="Remove this proxy">×</button>
    </div>`).join('');

  // Integration code
  $('#int-box').classList.toggle('hidden', !mine.length);
  if (!mine.length) return;
  if (!mine.some((s) => s.id === intId)) intId = mine[0].id;
  const sel = $('#int-proxy');
  sel.classList.toggle('hidden', mine.length < 2);
  const opts = mine.map((s) => `<option value="${s.id}">${esc(s.address)}:${s.port}${s.username ? ' (' + esc(s.username) + ')' : ''}</option>`).join('');
  if (sel.dataset.html !== opts) { sel.innerHTML = opts; sel.dataset.html = opts; }
  sel.value = intId;
  $$('#int-tabs button').forEach((b) => b.classList.toggle('active', b.dataset.lang === intLang));
  const server = mine.find((s) => s.id === intId);
  $('#int-code').textContent = integrationCode(server, intLang, { hide: !intShow });
  $('#int-show').textContent = intShow ? 'Hide password' : 'Show password';
  $('#int-show').classList.toggle('hidden', !server.username);
}

async function refresh() {
  S = await send('state');
  render();
}

async function checkHelper() {
  $('#helper-status').textContent = 'Checking…';
  const r = await send('helperStatus');
  if (r.ok) {
    $('#helper-status').textContent = `Installed ✓ ${r.version || ''}${r.running ? ' · running' : ''}`;
    $('#helper-help').classList.add('hidden');
  } else {
    $('#helper-status').textContent = r.missing ? 'Not installed (not needed for free servers)' : `Problem: ${r.error}`;
    $('#helper-help').classList.toggle('hidden', !S.servers.some((s) => s.kind === 'core'));
  }
}

async function withBusy(fn) {
  busy = true; render();
  try { await fn(); } catch (e) { alert(e.message); } finally { busy = false; await refresh(); }
}

// ---------- events ----------
$$('.tabs button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
function showTab(name) {
  $$('.tabs button').forEach((x) => x.classList.toggle('active', x.dataset.tab === name));
  $$('.tab').forEach((t) => t.classList.toggle('active', t.id === 'tab-' + name));
  if (name === 'settings') checkHelper();
}

$('#power').addEventListener('click', () => withBusy(async () => {
  const on = S.prefs.enabled && S.status.state === 'on';
  await send(on ? 'disconnect' : 'connect');
}));

$('#mode').addEventListener('click', async (e) => {
  const mode = e.target.dataset.mode;
  if (!mode) return;
  if (mode === 'targeted' && !S.prefs.sites.length && currentHost) await send('addSites', { sites: [currentHost] });
  await send('setPrefs', { patch: { mode } });
  await refresh();
});

$('#toggle-current').addEventListener('click', async () => {
  await send('addSites', { sites: [currentHost] });
  await refresh();
});

$('#home-sites').addEventListener('click', async (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  if (btn.dataset.goto) { showTab(btn.dataset.goto); return; }
  if (btn.dataset.removeSite) { await send('removeSites', { sites: [btn.dataset.removeSite] }); await refresh(); }
});

$('#server-pick').addEventListener('click', () => showTab('servers'));
$('#manage-sites').addEventListener('click', () => showTab('sites'));

$('#check-ip').addEventListener('click', async () => {
  ipText = 'Checking your IP…'; render();
  try {
    const r = await send('checkIp');
    ipText = r.success === false ? 'Could not check your IP'
      : `Your IP: ${r.ip} · ${[r.city, r.country].filter(Boolean).join(', ')} ${r.flag?.emoji || ''}`;
  } catch (e) {
    ipText = 'Could not check your IP: ' + e.message;
  }
  render();
});

$('#search').addEventListener('input', renderServers);
$('#country-filter').addEventListener('change', renderServers);

$('#server-list').addEventListener('click', async (e) => {
  if (e.target.id === 'show-all') { showAll = true; renderServers(); return; }
  const row = e.target.closest('.srv');
  if (!row) return;
  await savePref({ selected: row.dataset.id });
  showTab('home');
});

$('#test').addEventListener('click', async () => {
  S.testing = true; renderServers();
  try {
    const r = await send('test');
    if (r.ownError) alert('Your own servers were not tested: ' + r.ownError);
  } catch (e) { $('#test-info').textContent = e.message; return; }
  await refresh();
});

$('#sub-add').addEventListener('click', async () => {
  const url = $('#sub-url').value.trim();
  if (!url) return;
  $('#import-msg').textContent = 'Downloading…';
  try {
    const r = await send('addListUrl', { url });
    $('#import-msg').textContent = `Added ${r.added} servers.`;
    $('#sub-url').value = '';
  } catch (e) { $('#import-msg').textContent = e.message; }
  await refresh();
});

async function importText(text, name) {
  $('#import-msg').textContent = 'Importing…';
  try {
    const r = await send('importText', { text, name });
    $('#import-msg').textContent = `Added ${r.added} servers${r.skipped ? ` (${r.skipped} unsupported skipped)` : ''}.`;
  } catch (e) { $('#import-msg').textContent = e.message; }
  await refresh();
}
$('#paste-import').addEventListener('click', async () => {
  const text = $('#paste').value;
  if (!text.trim()) return;
  await importText(text, 'Pasted servers');
  $('#paste').value = '';
});
// File pickers close the small popup on some systems, so open a full tab for it.
$('#file').addEventListener('click', (e) => {
  if (!isFullPage) {
    e.preventDefault();
    chrome.tabs.create({ url: chrome.runtime.getURL('popup.html?full=1#servers') });
  }
});
$('#file').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  await importText(await f.text(), f.name.replace(/\.[^.]+$/, ''));
  e.target.value = '';
});
$('#sources').addEventListener('click', async (e) => {
  const id = e.target.dataset.removeSource;
  if (id && confirm('Remove this server list?')) { await send('removeSource', { id }); await refresh(); }
});

$('#site-add').addEventListener('click', addSiteFromInput);
$('#site-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') addSiteFromInput(); });
async function addSiteFromInput() {
  const raw = $('#site-input').value;
  const sites = raw.split(/[\s,]+/).filter(Boolean);
  if (!sites.length) return;
  if (!sites.some(normalizeSite)) { alert('That does not look like a website address. Example: youtube.com'); return; }
  await send('addSites', { sites });
  $('#site-input').value = '';
  await refresh();
}
$('#site-add-current').addEventListener('click', async () => {
  if (!currentHost) { alert('Open a normal website tab first.'); return; }
  await send('addSites', { sites: [currentHost] });
  await refresh();
});
$('#presets').addEventListener('click', async (e) => {
  const i = e.target.dataset.preset;
  if (i == null) return;
  const p = PRESETS[i];
  const allIn = p.domains.every((d) => S.prefs.sites.includes(d));
  await send(allIn ? 'removeSites' : 'addSites', { sites: p.domains });
  await refresh();
});
$('#site-list').addEventListener('click', async (e) => {
  const d = e.target.closest('button')?.dataset.removeSite;
  if (d) { await send('removeSites', { sites: [d] }); await refresh(); }
});

$('#helper-check').addEventListener('click', checkHelper);
// Note: read e.target.value BEFORE withBusy(), which re-renders (and resets) the controls.
function savePref(patch) { return withBusy(() => send('setPrefs', { patch })); }
$('#auto-pool').addEventListener('change', (e) => savePref({ autoPool: Number(e.target.value) }));
$('#home-country').addEventListener('change', (e) => savePref({ country: e.target.value }));
$('#auto-country').addEventListener('change', (e) => savePref({ country: e.target.value }));
for (const id of ['socks-port', 'http-port']) {
  $('#' + id).addEventListener('change', (e) => {
    const v = Number(e.target.value);
    if (v < 1024 || v > 65535) { alert('Port must be between 1024 and 65535'); return; }
    savePref({ [id === 'socks-port' ? 'socksPort' : 'httpPort']: v });
  });
}
$('#manual-core').addEventListener('change', (e) => savePref({ manualCore: e.target.checked }));
$('#server-source').addEventListener('change', (e) => {
  const source = e.target.value;
  if (source === 'custom' && !S.servers.some((s) => s.custom)) {
    alert('Paste your proxy under "My proxies" below and press "Add & test" first.');
    e.target.value = S.prefs.source || 'free';
    $('#custom-input').focus();
    return;
  }
  if ((source === 'proxio' || source === 'both') && !S.proxio?.hasKey) {
    alert('Add your Proxio.io API key below first, then press "Save & load servers".');
    e.target.value = S.prefs.source || 'free';
    $('#proxio-key').focus();
    return;
  }
  savePref({ source, selected: 'auto' });
});
$('#proxio-save').addEventListener('click', async () => {
  const key = $('#proxio-key').value.trim();
  if (!key && !S.proxio?.hasKey) { alert('Paste your Proxio.io API key first.'); return; }
  const type = $('#proxio-type').value;
  const limit = Number($('#proxio-limit').value);
  try {
    await send('proxioSave', { key, proxyType: type, limit });
    $('#proxio-key').value = '';
  } catch (e) { /* the error is shown in the status line */ }
  await refresh();
});
$('#custom-save').addEventListener('click', async () => {
  const text = $('#custom-input').value;
  if (!text.trim()) { alert('Paste your proxy first, e.g. curl --proxy "http://user:pass@1.2.3.4:6014/" https://ipv4.webshare.io/'); return; }
  try {
    await send('customSave', { text });
    $('#custom-input').value = '';
  } catch (e) {
    $('#custom-status').className = 'muted tiny err';
    $('#custom-status').textContent = e.message;
    return;
  }
  await refresh();
});
$('#custom-test').addEventListener('click', async () => {
  try { await send('customTest'); } catch { /* shown in status */ }
  await refresh();
});
$('#custom-list').addEventListener('click', async (e) => {
  const id = e.target.closest('button')?.dataset.removeCustom;
  if (!id) return;
  await send('customRemove', { id });
  await refresh();
});
$('#int-tabs').addEventListener('click', (e) => {
  const lang = e.target.closest('button')?.dataset.lang;
  if (lang) { intLang = lang; renderCustom(); }
});
$('#int-proxy').addEventListener('change', (e) => { intId = e.target.value; renderCustom(); });
$('#int-show').addEventListener('click', () => { intShow = !intShow; renderCustom(); });
$('#int-copy').addEventListener('click', async () => {
  const server = S.servers.find((s) => s.id === intId);
  if (!server) return;
  try {
    await navigator.clipboard.writeText(integrationCode(server, intLang)); // always the real password
    $('#int-copy').textContent = 'Copied ✓';
  } catch {
    $('#int-copy').textContent = 'Copy failed — select the code and copy it';
  }
  setTimeout(() => { $('#int-copy').textContent = 'Copy code'; }, 1800);
});
$('#proxio-refresh').addEventListener('click', async () => {
  try { await send('proxioRefresh'); } catch { /* shown in status */ }
  await refresh();
});
$('#proxio-remove').addEventListener('click', async () => {
  if (!confirm('Remove your Proxio.io key and its servers?')) return;
  await send('proxioRemove');
  $('#proxio-key').value = '';
  await refresh();
});
$('#export').addEventListener('click', async () => {
  try {
    const cfg = await send('exportConfig');
    const url = URL.createObjectURL(new Blob([JSON.stringify(cfg, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url; a.download = 'tervyn-xray-config.json'; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  } catch (e) { alert(e.message); }
});

chrome.storage.onChanged.addListener(() => { refresh(); });

// ---------- init ----------
(async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.url && /^https?:/.test(tab.url) && !isFullPage) currentHost = normalizeSite(new URL(tab.url).hostname);
  } catch { /* no tab */ }
  send('ensureFree').catch(() => {});
  await refresh();
  const hash = location.hash.slice(1);
  if (hash) showTab(hash);
})();
