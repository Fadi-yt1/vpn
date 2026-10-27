import { PRESETS } from './lib/presets.js';
import { normalizeSite } from './lib/pac.js';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];
const isFullPage = new URLSearchParams(location.search).has('full');
if (isFullPage) document.body.classList.add('full');

let S = null;          // last state from background
let busy = false;
let showAll = false;   // server list paging
let currentHost = '';

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
function render() {
  if (!S) return;
  const { prefs, status, servers, pings } = S;
  const on = prefs.enabled && status.state === 'on';
  const connecting = status.state === 'connecting' || busy;

  const power = $('#power');
  power.classList.toggle('on', on);
  power.classList.toggle('busy', connecting);
  power.classList.toggle('targeted', prefs.mode === 'targeted');
  $('#state-text').textContent = connecting ? 'Connecting…' : on ? (prefs.mode === 'targeted' ? 'On for your sites' : 'Protected') : 'Not connected';
  const fsx = S.freeStatus || {};
  $('#state-sub').textContent = on ? status.label || ''
    : fsx.state === 'loading' ? 'Finding free servers…'
      : fsx.state === 'testing' ? `Testing free servers… ${fsx.progress || 0}%`
        : servers.length ? `${servers.length} fast servers ready` : 'Press the button — free servers are found automatically';

  $('#error').classList.toggle('hidden', !status.error);
  $('#error').textContent = status.error || '';
  $('#warning').classList.toggle('hidden', !(on && status.warning));
  $('#warning').textContent = status.warning || '';

  $$('#mode button').forEach((b) => b.classList.toggle('active', b.dataset.mode === prefs.mode));

  // current tab site toggle (targeted mode)
  const cs = $('#current-site');
  cs.classList.toggle('hidden', !(prefs.mode === 'targeted' && currentHost));
  if (currentHost) {
    const site = prefs.sites.find((d) => currentHost === d || currentHost.endsWith('.' + d));
    $('#current-host').textContent = currentHost;
    const t = $('#toggle-current');
    t.textContent = site ? 'Remove from VPN' : 'Use VPN here';
    t.classList.toggle('primary', !site);
    t.dataset.site = site || '';
  }

  // selected server card
  const sel = prefs.selected === 'auto' ? null : servers.find((s) => s.id === prefs.selected);
  $('#server-flag').textContent = sel ? sel.flag : '⚡';
  $('#server-name').textContent = sel ? serverTitle(sel) : 'Auto · fastest server';
  $('#server-sub').textContent = sel ? serverSub(sel)
    : `Free · uses the fastest working server${prefs.country ? ' in ' + prefs.country : ''}, backups take over automatically`;

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
  const opts = [`<option value="">${anyLabel}</option>`, ...countries().map(([c, n]) => `<option value="${esc(c)}">${flagOf(c)} ${esc(c)} (${n})</option>`)];
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
  const list = servers
    .filter((s) => !cf || s.country === cf)
    .filter((s) => !q || `${s.name} ${s.address} ${s.sni} ${s.country} ${s.proto} ${s.net}`.toLowerCase().includes(q))
    .sort((a, b) => score(a) - score(b));

  const fs = S.freeStatus || {};
  const busyTest = S.testing || S.refreshing || fs.state === 'loading' || fs.state === 'testing';
  $('#test-info').textContent = fs.state === 'loading' ? 'Downloading free server lists…'
    : fs.state === 'testing' ? `Testing ${fs.found || ''} free servers… ${fs.progress || 0}%`
      : fs.error ? fs.error
        : fs.at ? `${fs.working} fast free servers found (checked ${fs.found}). Updated ${new Date(fs.at).toLocaleTimeString()} · refreshes every 30 min.`
          : 'Free servers are being prepared…';
  $('#test').disabled = busyTest;
  $('#test').textContent = busyTest ? 'Searching…' : 'Find fastest free servers';

  const limit = showAll ? list.length : 60;
  const rows = [`
    <div class="srv ${prefs.selected === 'auto' ? 'selected' : ''}" data-id="auto">
      <span class="flag">⚡</span>
      <div class="info"><div class="name">Auto · fastest free server</div><div class="sub">Recommended — no setup, switches automatically</div></div>
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
  if (!servers.length) rows.push('<p class="muted small center">Finding free servers for you… this takes about 30 seconds the first time.</p>');
  $('#server-list').innerHTML = rows.join('');

  $('#sources').innerHTML = S.sources.map((src) => `
    <div class="source">
      <div class="grow"><div class="strong">${esc(src.name)}</div>
      <div class="muted small">${src.count} servers · updated ${new Date(src.updatedAt).toLocaleString()}${src.type === 'url' ? ' · auto-updates' : ''}</div></div>
      <button class="btn small danger" data-remove-source="${src.id}">Remove</button>
    </div>`).join('');
}

function renderSites() {
  const { prefs } = S;
  $('#site-count').textContent = prefs.sites.length ? `(${prefs.sites.length})` : '';
  $('#site-list').innerHTML = prefs.sites.length
    ? prefs.sites.map((d) => `<div class="site"><span>${esc(d)}</span><button data-remove-site="${esc(d)}" title="Remove">×</button></div>`).join('')
    : '<p class="muted small">No sites yet. Add one above or use Quick add.</p>';
  $('#presets').innerHTML = PRESETS.map((p, i) => {
    const added = p.domains.every((d) => prefs.sites.includes(d));
    return `<button class="chip ${added ? 'added' : ''}" data-preset="${i}">${added ? '✓ ' : '+ '}${esc(p.name)}</button>`;
  }).join('');
}

function renderSettings() {
  const { prefs } = S;
  $('#auto-pool').value = String(prefs.autoPool);
  fillCountrySelect($('#auto-country'), prefs.country, 'Any country (fastest)');
  if (document.activeElement !== $('#socks-port')) $('#socks-port').value = prefs.socksPort;
  if (document.activeElement !== $('#http-port')) $('#http-port').value = prefs.httpPort;
  $('#manual-core').checked = prefs.manualCore;
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

$('#toggle-current').addEventListener('click', async (e) => {
  const site = e.target.dataset.site;
  if (site) await send('removeSites', { sites: [site] });
  else await send('addSites', { sites: [currentHost] });
  await refresh();
});

$('#server-pick').addEventListener('click', () => showTab('servers'));

$('#check-ip').addEventListener('click', async () => {
  $('#ip-result').textContent = 'Checking…';
  try {
    const r = await send('checkIp');
    $('#ip-result').textContent = r.success === false ? 'Could not check' : `${r.flag?.emoji || ''} ${r.ip} · ${r.city || ''} ${r.country || ''}`;
  } catch (e) {
    $('#ip-result').textContent = 'Could not check: ' + e.message;
  }
});

$('#search').addEventListener('input', renderServers);
$('#country-filter').addEventListener('change', renderServers);

$('#server-list').addEventListener('click', async (e) => {
  if (e.target.id === 'show-all') { showAll = true; renderServers(); return; }
  const row = e.target.closest('.srv');
  if (!row) return;
  await withBusy(() => send('setPrefs', { patch: { selected: row.dataset.id } }));
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
  const d = e.target.dataset.removeSite;
  if (d) { await send('removeSites', { sites: [d] }); await refresh(); }
});

$('#helper-check').addEventListener('click', checkHelper);
$('#auto-pool').addEventListener('change', (e) => withBusy(() => send('setPrefs', { patch: { autoPool: Number(e.target.value) } })));
$('#auto-country').addEventListener('change', (e) => withBusy(() => send('setPrefs', { patch: { country: e.target.value } })));
for (const id of ['socks-port', 'http-port']) {
  $('#' + id).addEventListener('change', (e) => {
    const v = Number(e.target.value);
    if (v < 1024 || v > 65535) { alert('Port must be between 1024 and 65535'); return; }
    withBusy(() => send('setPrefs', { patch: { [id === 'socks-port' ? 'socksPort' : 'httpPort']: v } }));
  });
}
$('#manual-core').addEventListener('change', (e) => withBusy(() => send('setPrefs', { patch: { manualCore: e.target.checked } })));
$('#export').addEventListener('click', async () => {
  try {
    const cfg = await send('exportConfig');
    const url = URL.createObjectURL(new Blob([JSON.stringify(cfg, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url; a.download = 'opengate-xray-config.json'; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  } catch (e) { alert(e.message); }
});

chrome.storage.onChanged.addListener(() => { if (!busy) refresh(); });

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
