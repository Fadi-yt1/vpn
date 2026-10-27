import { parseSubscription, hashId } from './lib/links.js';
import { buildConfig, toOutbound } from './lib/xray.js';
import { buildPac, proxyString, normalizeSite, IP_CHECK_HOST } from './lib/pac.js';
import { fetchFreeProxies, addCountries } from './lib/freeproxies.js';

const HOST = 'com.opengate.vpn';
const HELPER_MISSING = 'Your own VLESS/Trojan servers need the optional helper (Settings). Free servers work without it — pick "Auto".';
const FREE_REFRESH_MIN = 30;
const KEEP_FREE = 40;          // working free servers to keep

const DEFAULT_PREFS = {
  enabled: false,
  mode: 'full',            // 'full' = all sites, 'targeted' = only listed sites
  selected: 'auto',        // 'auto' or a server id
  sites: [],
  socksPort: 10808,
  httpPort: 10809,
  autoPool: 5,             // how many of the fastest servers auto mode chains/balances
  country: '',             // limit auto mode to one country ('' = any)
  manualCore: false,       // user runs xray themselves (no helper)
  bypass: [],
};

// ---------- storage helpers ----------
async function get(keys) { return chrome.storage.local.get(keys); }
async function set(obj) { return chrome.storage.local.set(obj); }

async function getPrefs() {
  const { prefs } = await get('prefs');
  return { ...DEFAULT_PREFS, ...(prefs || {}) };
}
async function savePrefs(patch) {
  const prefs = { ...(await getPrefs()), ...patch };
  await set({ prefs });
  return prefs;
}
async function getOwnServers() { return (await get('servers')).servers || []; }
async function getFreeServers() { return (await get('freeServers')).freeServers || []; }
async function getAllServers() { return [...(await getFreeServers()), ...(await getOwnServers())]; }
async function getSources() { return (await get('sources')).sources || []; }
async function getPings() { return (await get('pings')).pings || {}; }
async function getStatus() { return (await get('status')).status || {}; }
async function setStatus(patch) {
  const status = { ...(await getStatus()), ...patch };
  await set({ status });
  return status;
}
async function getFreeStatus() { return (await get('freeStatus')).freeStatus || {}; }
async function setFreeStatus(patch) { await set({ freeStatus: { ...(await getFreeStatus()), ...patch } }); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- native helper (optional, only for your own VLESS/Trojan servers) ----------
async function native(msg) {
  try {
    const res = await chrome.runtime.sendNativeMessage(HOST, msg);
    return res || { ok: false, error: 'Empty reply from helper' };
  } catch (e) {
    return { ok: false, missing: true, error: String(e.message || e) };
  }
}

// ---------- your own servers (optional) ----------
async function importText(text, source) {
  const { servers, meta, skipped } = parseSubscription(text);
  if (!servers.length) throw new Error('No usable servers found in this text/file.');
  const all = (await getOwnServers()).filter((s) => s.sourceId !== source.id);
  for (const s of servers) s.sourceId = source.id;
  await set({ servers: [...all, ...servers] });

  const sources = (await getSources()).filter((s) => s.id !== source.id);
  sources.push({
    ...source,
    name: source.name || meta['profile-title'] || (source.url ? new URL(source.url).hostname : 'Imported list'),
    count: servers.length,
    skipped,
    updatedAt: Date.now(),
  });
  await set({ sources });
  return { added: servers.length, skipped };
}

async function fetchText(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`Download failed (${res.status})`);
  return res.text();
}

async function addListUrl(url) {
  return importText(await fetchText(url), { id: hashId(url), type: 'url', url });
}

async function refreshListUrls() {
  for (const src of (await getSources()).filter((s) => s.type === 'url')) {
    try { await importText(await fetchText(src.url), src); } catch { /* keep old copy */ }
  }
}

async function removeSource(id) {
  await set({
    servers: (await getOwnServers()).filter((s) => s.sourceId !== id),
    sources: (await getSources()).filter((s) => s.id !== id),
  });
  const prefs = await getPrefs();
  if (prefs.selected !== 'auto' && !(await getAllServers()).some((s) => s.id === prefs.selected)) {
    await savePrefs({ selected: 'auto' });
  }
}

// ---------- testing free proxies inside the browser ----------
// We temporarily install a PAC script that sends each test request through a
// different proxy, then run many requests in parallel and time them.
async function setTestPac(tests) {
  const prefs = await getPrefs();
  const { activeProxy } = await get('activeProxy');
  const on = prefs.enabled && activeProxy;
  const pac = buildPac({
    mode: prefs.mode, sites: prefs.sites, bypass: prefs.bypass, tests,
    proxy: on ? activeProxy : 'DIRECT', enabled: !!on,
  });
  await chrome.proxy.settings.set({ value: { mode: 'pac_script', pacScript: { data: pac } }, scope: 'regular' });
  await sleep(400); // let Chrome pick up the new rules
}

async function restoreProxy() {
  const prefs = await getPrefs();
  const { activeProxy } = await get('activeProxy');
  if (prefs.enabled && activeProxy) await applyPac(prefs, activeProxy);
  else await chrome.proxy.settings.clear({ scope: 'regular' });
}

async function timedFetch(url, timeout) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  const start = performance.now();
  try {
    await fetch(url, { mode: 'no-cors', cache: 'no-store', credentials: 'omit', signal: ctl.signal });
    return Math.round(performance.now() - start);
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

// HTTPS test addresses nobody browses normally (so real browsing never
// goes through a server that is still being tested).
const HTTPS_TEST_HOSTS = [
  'connectivitycheck.gstatic.com', 'clients3.google.com', 'detectportal.firefox.com', 'one.one.one.one',
  'example.com', 'example.org', 'example.net', 'www.example.com', 'www.example.org', 'www.example.net',
];

// Only one test may change the routing rules at a time.
let testLock = Promise.resolve();
function testProxiesInBrowser(servers, opts) {
  const run = testLock.then(() => runProxyTest(servers, opts));
  testLock = run.catch(() => {});
  return run;
}

async function runProxyTest(servers, { onProgress } = {}) {
  const results = {};
  const nonce = Math.random().toString(36).slice(2, 8);
  try {
    // Phase 1: plain HTTP through each proxy, many at once.
    const CHUNK = 100;
    for (let i = 0; i < servers.length; i += CHUNK) {
      const chunk = servers.slice(i, i + CHUNK);
      const byTag = {};
      chunk.forEach((s, j) => { byTag[`${nonce}_${i + j}`] = proxyString(s); });
      await setTestPac({ byTag });
      await Promise.all(chunk.map(async (s, j) => {
        results[s.id] = await timedFetch(`http://www.gstatic.com/generate_204?ogt=${nonce}_${i + j}`, 7000);
      }));
      onProgress?.(Math.min(i + CHUNK, servers.length), servers.length);
    }
    // Phase 2: secure (HTTPS) sites through the ones that passed, fastest first.
    const passed = servers.filter((s) => results[s.id] != null).sort((a, b) => results[a.id] - results[b.id]).slice(0, 80);
    for (const s of servers) if (!passed.includes(s)) results[s.id] = null;
    for (let i = 0; i < passed.length; i += HTTPS_TEST_HOSTS.length) {
      const round = passed.slice(i, i + HTTPS_TEST_HOSTS.length);
      const byHost = {};
      round.forEach((s, j) => { byHost[HTTPS_TEST_HOSTS[j]] = proxyString(s); });
      await setTestPac({ byHost });
      await Promise.all(round.map(async (s, j) => {
        results[s.id] = await timedFetch(`https://${HTTPS_TEST_HOSTS[j]}/?ogt=${nonce}`, 8000);
      }));
    }
  } finally {
    await restoreProxy();
  }
  return results;
}

// ---------- free servers: find, test, keep the fastest ----------
let refreshing = null;
async function refreshFree({ force = false } = {}) {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    const fs = await getFreeStatus();
    if (!force && fs.at && Date.now() - fs.at < 5 * 60 * 1000 && (await getFreeServers()).length) return fs;
    await setFreeStatus({ state: 'loading', error: '' });
    try {
      const { candidates, sourcesOk } = await fetchFreeProxies({ max: 500 });
      if (!candidates.length) throw new Error('Could not download any free server lists. Check your internet connection.');
      // Re-test the servers that worked last time too.
      const previous = await getFreeServers();
      const pool = [...previous, ...candidates.filter((c) => !previous.some((p) => p.id === c.id))];
      await setFreeStatus({ state: 'testing', found: pool.length, progress: 0 });
      const ms = await testProxiesInBrowser(pool, {
        onProgress: (done, total) => setFreeStatus({ progress: Math.round((done / total) * 100) }),
      });
      const working = pool.filter((s) => ms[s.id] != null).sort((a, b) => ms[a.id] - ms[b.id]).slice(0, KEEP_FREE);
      await addCountries(working);
      const pings = await getPings();
      for (const s of pool) delete pings[s.id];
      for (const s of working) pings[s.id] = { ms: ms[s.id], kind: 'real', at: Date.now() };
      await set({ freeServers: working, pings });
      const st = { state: 'idle', at: Date.now(), found: pool.length, working: working.length, sources: sourcesOk, error: '' };
      if (!working.length) st.error = 'No free server answered right now. Trying again soon.';
      await setFreeStatus(st);
      // Keep an active connection on the fresh list.
      const prefs = await getPrefs();
      // (not awaited: connect() may itself be waiting for this refresh)
      if (prefs.enabled && prefs.selected === 'auto' && !connecting && (await getStatus()).usingFree) connect();
      return st;
    } catch (e) {
      await setFreeStatus({ state: 'idle', error: e.message || String(e) });
      throw e;
    }
  })();
  try { return await refreshing; } finally { refreshing = null; }
}

// ---------- speed test of your own (Xray) servers via the helper ----------
let testing = null;
async function testOwnServers(onlyIds) {
  if (testing) return testing;
  testing = (async () => {
    let servers = (await getOwnServers()).filter((s) => s.kind === 'core');
    if (onlyIds) servers = servers.filter((s) => onlyIds.includes(s.id));
    const pings = await getPings();
    const now = Date.now();
    if (servers.length) {
      const hostOf = (s) => `${s.address}:${s.port}`;
      const hosts = [...new Map(servers.map((s) => [hostOf(s), s])).values()];
      const tcp = await native({ cmd: 'tcpping', items: hosts.map((s) => ({ key: hostOf(s), host: s.address, port: s.port })), timeout: 3 });
      if (!tcp.ok) throw new Error(HELPER_MISSING);
      const reachable = servers.filter((s) => tcp.results[hostOf(s)] != null);
      const items = reachable.map((s, i) => ({ key: s.id, outbound: toOutbound(s, `t${i}`) }));
      const res = items.length
        ? await native({ cmd: 'realtest', items, timeout: 5, url: 'http://www.gstatic.com/generate_204' })
        : { ok: true, results: {} };
      for (const s of servers) pings[s.id] = { ms: res.ok ? res.results[s.id] ?? null : null, kind: 'real', at: now };
    }
    // Plain HTTP/SOCKS proxies you added yourself are tested in the browser.
    const direct = (await getOwnServers()).filter((s) => s.kind === 'direct' && (!onlyIds || onlyIds.includes(s.id)));
    if (direct.length) {
      const ms = await testProxiesInBrowser(direct);
      for (const s of direct) pings[s.id] = { ms: ms[s.id], kind: 'real', at: now };
    }
    await set({ pings });
    return { tested: servers.length + direct.length };
  })();
  try { return await testing; } finally { testing = null; }
}

async function testAll() {
  const own = await getOwnServers();
  let ownError = '';
  if (own.length) {
    try { await testOwnServers(); } catch (e) { ownError = e.message; }
  }
  const st = await refreshFree({ force: true });
  return { ...st, ownError };
}

// ---------- choosing servers ----------
function rank(servers, pings) {
  const score = (s) => {
    const p = pings[s.id];
    if (!p) return 50000;
    if (p.ms == null) return 100000;
    return p.ms;
  };
  return [...servers].sort((a, b) => score(a) - score(b));
}

async function helperOk() {
  return (await native({ cmd: 'status' })).ok;
}

// Returns { servers, core } — core=true means they run through Xray via the helper.
async function pickServers(prefs) {
  const all = await getAllServers();
  if (prefs.selected !== 'auto') {
    const s = all.find((x) => x.id === prefs.selected);
    if (s) return { servers: [s], core: s.kind === 'core' };
  }
  const pings = await getPings();
  const inCountry = (list) => {
    if (!prefs.country) return list;
    const f = list.filter((s) => s.country === prefs.country);
    return f.length ? f : list;
  };
  const works = (s) => pings[s.id]?.ms != null;

  // Your own Xray servers, if you added some and the helper is installed.
  const own = (await getOwnServers()).filter((s) => s.kind === 'core');
  if (own.length && (prefs.manualCore || await helperOk())) {
    const ranked = rank(inCountry(own), pings);
    const ok = ranked.filter(works);
    return { servers: (ok.length ? ok : ranked).slice(0, Math.max(1, prefs.autoPool + 3)), core: true };
  }

  // Otherwise: free servers (no setup), plus any plain proxies you added.
  let free = [...(await getFreeServers()), ...(await getOwnServers()).filter((s) => s.kind === 'direct')].filter(works);
  if (!free.length) {
    await refreshFree({ force: true }).catch(() => {});
    free = (await getFreeServers()).filter(works);
  }
  const ranked = rank(inCountry(free), await getPings());
  return { servers: ranked.slice(0, Math.max(2, prefs.autoPool)), core: false };
}

// ---------- proxy control ----------
async function applyPac(prefs, proxy) {
  const pac = buildPac({ mode: prefs.mode, sites: prefs.sites, bypass: prefs.bypass, proxy });
  await chrome.proxy.settings.set({ value: { mode: 'pac_script', pacScript: { data: pac } }, scope: 'regular' });
}

let connecting = null;
async function connect() {
  if (connecting) return connecting;
  connecting = doConnect();
  try { return await connecting; } finally { connecting = null; }
}

async function doConnect() {
  const prefs = await savePrefs({ enabled: true });
  await setStatus({ state: 'connecting', error: '', warning: '' });
  try {
    if (prefs.mode === 'targeted' && !prefs.sites.length) {
      throw new Error('"Only my site list" is on but the list is empty. Add a site in the Sites tab.');
    }
    let { servers, core } = await pickServers(prefs);
    if (!servers.length) throw new Error('No free server is answering right now. Press "Find fastest free servers" in the Servers tab, or try again in a minute.');

    let proxy;
    if (core) {
      if (!prefs.manualCore) {
        let res = await native({ cmd: 'start', config: buildConfig(servers, prefs) });
        if (!res.ok && servers.length > 1 && !res.missing) {
          servers = servers.slice(0, 1); // one bad server can break the auto config
          res = await native({ cmd: 'start', config: buildConfig(servers, prefs) });
        }
        if (!res.ok) throw new Error(res.missing ? HELPER_MISSING : `Helper error: ${res.error}`);
      }
      proxy = proxyString(null, prefs.socksPort);
    } else {
      if (!prefs.manualCore) await native({ cmd: 'stop' });
      proxy = proxyString(servers, prefs.socksPort); // failover chain
    }
    await applyPac(prefs, proxy);
    await set({ activeProxy: proxy, activeDirect: core ? null : servers[0] });
    const first = servers[0];
    const label = prefs.selected === 'auto'
      ? `Auto · ${first.flag} ${first.country !== 'Unknown' ? first.country : first.name}${servers.length > 1 ? ` + ${servers.length - 1} backup` : ''}`
      : `${first.flag} ${first.country !== 'Unknown' ? first.country : first.name}`;
    await setStatus({ state: 'on', label, servers: servers.map((s) => s.id), usingFree: !core, since: Date.now(), error: '' });
  } catch (e) {
    await savePrefs({ enabled: false });
    await set({ activeProxy: null });
    await chrome.proxy.settings.clear({ scope: 'regular' });
    await setStatus({ state: 'off', error: e.message || String(e) });
  }
  await updateBadge();
  return getStatus();
}

async function disconnect() {
  await savePrefs({ enabled: false });
  await chrome.proxy.settings.clear({ scope: 'regular' });
  await set({ activeProxy: null, activeDirect: null });
  const prefs = await getPrefs();
  if (!prefs.manualCore) await native({ cmd: 'stop' });
  await setStatus({ state: 'off', error: '', warning: '', label: '' });
  await updateBadge();
  return getStatus();
}

async function refreshProxyIfOn() {
  const prefs = await getPrefs();
  if (!prefs.enabled) return;
  if (prefs.mode === 'targeted' && !prefs.sites.length) return;
  const { activeProxy } = await get('activeProxy');
  if (activeProxy) await applyPac(prefs, activeProxy);
  await updateBadge();
}

async function updateBadge() {
  const prefs = await getPrefs();
  const status = await getStatus();
  const on = prefs.enabled && status.state === 'on';
  await chrome.action.setBadgeText({ text: on ? (prefs.mode === 'targeted' ? 'SITE' : 'ON') : '' });
  await chrome.action.setBadgeBackgroundColor({ color: prefs.mode === 'targeted' ? '#6366f1' : '#16a34a' });
  const v = on ? 'on' : 'off';
  await chrome.action.setIcon({ path: { 16: `icons/${v}16.png`, 32: `icons/${v}32.png`, 48: `icons/${v}48.png` } });
}

// ---------- sites ----------
async function addSites(list) {
  const prefs = await getPrefs();
  const sites = new Set(prefs.sites);
  let added = 0;
  for (const raw of list) {
    const d = normalizeSite(raw);
    if (d && !sites.has(d)) { sites.add(d); added++; }
  }
  await savePrefs({ sites: [...sites].sort() });
  await refreshProxyIfOn();
  return { added };
}

async function removeSites(list) {
  const prefs = await getPrefs();
  await savePrefs({ sites: prefs.sites.filter((s) => !list.includes(s)) });
  await refreshProxyIfOn();
}

// ---------- automatic failover ----------
// Chrome already skips a dead server in the chain; if errors keep coming,
// drop the first server and, when we run low, fetch a fresh list.
let errorTimes = [];
chrome.proxy.onProxyError.addListener(async (details) => {
  const prefs = await getPrefs();
  const status = await getStatus();
  if (!prefs.enabled || status.state !== 'on') return;
  if (!/PROXY|SOCKS|TUNNEL/.test(details.error)) return;
  const now = Date.now();
  errorTimes = errorTimes.filter((t) => now - t < 20000);
  errorTimes.push(now);
  if (errorTimes.length < 4) return;
  errorTimes = [];
  if (status.usingFree) {
    const dead = status.servers?.[0];
    if (dead) {
      const pings = await getPings();
      pings[dead] = { ms: null, kind: 'real', at: now };
      await set({ pings });
    }
    await setStatus({ warning: 'A server stopped answering — switched to the next fastest one.' });
    await connect();
    const fresh = await getPings();
    const left = (await getFreeServers()).filter((s) => fresh[s.id]?.ms != null).length;
    if (left < 3) refreshFree({ force: true }).catch(() => {});
  } else {
    await setStatus({ warning: `Can't reach the VPN (${details.error}). Try another server.` });
  }
});

// Logins for plain HTTP/SOCKS proxies you added that need a username.
chrome.webRequest.onAuthRequired.addListener(
  (details, callback) => {
    get('activeDirect').then(({ activeDirect: d }) => {
      if (details.isProxy && d && d.username) callback({ authCredentials: { username: d.username, password: d.password } });
      else callback({});
    });
  },
  { urls: ['<all_urls>'] },
  ['asyncBlocking'],
);

// ---------- lifecycle ----------
chrome.runtime.onInstalled.addListener(async () => {
  chrome.alarms.create('refresh', { periodInMinutes: FREE_REFRESH_MIN });
  await updateBadge();
  refreshFree({ force: true }).catch(() => {}); // find free servers right away
});

chrome.runtime.onStartup.addListener(async () => {
  const prefs = await getPrefs();
  if (prefs.enabled) await connect();
  else await updateBadge();
  refreshFree().catch(() => {});
});

chrome.alarms.onAlarm.addListener(async (a) => {
  if (a.name !== 'refresh') return;
  await refreshListUrls();
  await refreshFree({ force: true }).catch(() => {});
});

const handlers = {
  async state() {
    const [prefs, status, servers, sources, pings, freeStatus] = await Promise.all(
      [getPrefs(), getStatus(), getAllServers(), getSources(), getPings(), getFreeStatus()]);
    return { prefs, status, servers, sources, pings, freeStatus, refreshing: !!refreshing, testing: !!testing };
  },
  connect: () => connect(),
  disconnect: () => disconnect(),
  async setPrefs({ patch }) {
    const before = await getPrefs();
    const prefs = await savePrefs(patch);
    const needsReconnect = prefs.enabled && ['selected', 'country', 'autoPool', 'socksPort', 'httpPort', 'manualCore']
      .some((k) => k in patch && patch[k] !== before[k]);
    if (needsReconnect) await connect();
    else if ('mode' in patch || 'bypass' in patch) await refreshProxyIfOn();
    return prefs;
  },
  ensureFree: () => { refreshFree().catch(() => {}); return true; },
  test: () => testAll(),
  importText: ({ text, name }) => importText(text, { id: hashId('paste:' + (name || '') + Date.now()), type: 'paste', name }),
  addListUrl: ({ url }) => addListUrl(url),
  removeSource: ({ id }) => removeSource(id),
  addSites: ({ sites }) => addSites(sites),
  removeSites: ({ sites }) => removeSites(sites),
  helperStatus: () => native({ cmd: 'status' }),
  async exportConfig() {
    const own = (await getOwnServers()).filter((s) => s.kind === 'core');
    if (!own.length) throw new Error('Export is only for your own VLESS/VMess/Trojan servers.');
    const prefs = await getPrefs();
    return buildConfig(rank(own, await getPings()).slice(0, prefs.autoPool + 3), prefs);
  },
  async checkIp() {
    const res = await fetch(`https://${IP_CHECK_HOST}/`, { cache: 'no-store' });
    return res.json();
  },
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const fn = handlers[msg?.type];
  if (!fn) return false;
  Promise.resolve(fn(msg))
    .then((data) => sendResponse({ ok: true, data }))
    .catch((e) => sendResponse({ ok: false, error: e.message || String(e) }));
  return true;
});
