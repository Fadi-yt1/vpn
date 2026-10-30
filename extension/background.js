import { parseSubscription, hashId } from './lib/links.js';
import { buildConfig, toOutbound } from './lib/xray.js';
import { buildPac, proxyString, normalizeSite, IP_CHECK_HOST } from './lib/pac.js';
import { fetchFreeProxies, addCountries, flagFromCode, countryName } from './lib/freeproxies.js';
import { fetchProxio } from './lib/proxio.js';
import { extractProxies, withCountry, parseProxyListFile } from './lib/integration.js';

const HOST = 'com.opengate.vpn';
const HELPER_MISSING = 'Your own VLESS/Trojan servers need the optional helper (Settings). Free servers work without it — pick "Auto".';
const FREE_REFRESH_MIN = 30;
const KEEP_FREE = 40;          // working free servers to keep

const DEFAULT_PREFS = {
  enabled: false,
  mode: 'full',            // 'full' = all sites, 'targeted' = only listed sites
  selected: 'auto',        // 'auto' or a server id
  autoSwitch: true,        // true = always use the fastest servers and switch automatically
  pinned: null,            // copy of the chosen server when auto-switch is off
  sites: [],
  socksPort: 10808,
  httpPort: 10809,
  autoPool: 5,             // how many of the fastest servers auto mode chains/balances
  country: '',             // limit auto mode to one country ('' = any)
  manualCore: false,       // user runs xray themselves (no helper)
  source: 'free',          // 'free' | 'proxio' (Proxio.io only) | 'both' | 'custom' (My proxies) | 'list' (Proxy list file)
  bypass: [],
};

// ---------- storage helpers ----------
async function get(keys) { return chrome.storage.local.get(keys); }
async function set(obj) { return chrome.storage.local.set(obj); }

async function getPrefs() {
  const { prefs } = await get('prefs');
  const p = { ...DEFAULT_PREFS, ...(prefs || {}) };
  p.autoSwitch = p.selected === 'auto'; // one source of truth: the selection
  return p;
}
async function savePrefs(patch) {
  const prefs = { ...(await getPrefs()), ...patch };
  await set({ prefs });
  return prefs;
}
async function getOwnServers() { return (await get('servers')).servers || []; }
async function getFreeServers() { return (await get('freeServers')).freeServers || []; }
async function getProxioServers() { return (await get('proxioServers')).proxioServers || []; }
// The user's own proxies: kind 'custom' = "My proxies", 'list' = "Proxy list file".
const USER_KINDS = ['custom', 'list'];
async function getUserServers(kind) { const k = `${kind}Servers`; return (await get(k))[k] || []; }
async function getUserStatus(kind) { const k = `${kind}Status`; return (await get(k))[k] || {}; }
async function setUserStatus(kind, patch) { await set({ [`${kind}Status`]: { ...(await getUserStatus(kind)), ...patch } }); }
async function getAllServers() {
  return [...(await getUserServers('custom')), ...(await getUserServers('list')), ...(await getProxioServers()), ...(await getFreeServers()), ...(await getOwnServers())];
}
async function getProxioConfig() { return (await get('proxio')).proxio || {}; }
async function getProxioStatus() { return (await get('proxioStatus')).proxioStatus || {}; }
async function setProxioStatus(patch) { await set({ proxioStatus: { ...(await getProxioStatus()), ...patch } }); }
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
    await handlers.setPrefs({ patch: { selected: 'auto' } });
  }
}

// ---------- testing proxies inside the browser ----------
// We temporarily install a PAC script that sends each test request through a
// different proxy, run many requests in parallel and time them.
async function setTestPac(tests) {
  const prefs = await getPrefs();
  const { activeProxy } = await get('activeProxy');
  const on = prefs.enabled && activeProxy;
  const pac = buildPac({
    mode: prefs.mode, sites: prefs.sites, bypass: prefs.bypass, tests,
    proxy: on ? activeProxy : 'DIRECT', enabled: !!on,
  });
  await chrome.proxy.settings.set({ value: { mode: 'pac_script', pacScript: { data: pac } }, scope: 'regular' });
  await sleep(300); // let Chrome pick up the new rules
}

async function restoreProxy() {
  const prefs = await getPrefs();
  const { activeProxy } = await get('activeProxy');
  if (prefs.enabled && activeProxy) await applyPac(prefs, activeProxy);
  else await chrome.proxy.settings.clear({ scope: 'regular' });
}

// Returns { ms, text } or null if the request failed or timed out.
async function timedFetch(url, timeout, read = false) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  const start = performance.now();
  try {
    const res = await fetch(url, { mode: read ? 'cors' : 'no-cors', cache: 'no-store', credentials: 'omit', signal: ctl.signal });
    const ms = Math.round(performance.now() - start);
    const text = read ? await res.text() : '';
    return { ms, text };
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

// Cloudflare addresses that answer /cdn-cgi/trace with the visitor's IP and
// country. Nobody browses them normally, so real browsing never goes through
// a server that is still being tested. The HTTPS certificate is checked, so a
// server that tampers with traffic fails the test.
const TRACE_HOSTS = [
  'one.one.one.one', '1.0.0.1', 'speed.cloudflare.com', 'cloudflare-quic.com', 'www.cloudflare.com',
  'blog.cloudflare.com', 'developers.cloudflare.com', 'radar.cloudflare.com', 'workers.cloudflare.com',
  'community.cloudflare.com',
];

// Only one test may change the routing rules at a time.
let testLock = Promise.resolve();
function testProxiesInBrowser(servers, opts) {
  const run = testLock.then(() => runProxyTest(servers, opts));
  testLock = run.catch(() => {});
  return run;
}

// Result per server id: { ms, code } when it works, null when it doesn't.
//   quick:     skip phase 1 (for re-checking servers that worked recently)
//   stopAfter: stop once this many working servers were found
//   maxTime:   stop after this many ms
//   onBatch:   called after each batch with the results so far
let testsRunning = 0;
async function runProxyTest(servers, { quick = false, stopAfter = Infinity, maxTime = Infinity, onBatch } = {}) {
  const results = {};
  testsRunning++;
  const nonce = Math.random().toString(36).slice(2, 8);
  const started = Date.now();
  const CHUNK = 150;
  try {
    for (let i = 0; i < servers.length; i += CHUNK) {
      const chunk = servers.slice(i, i + CHUNK);
      let passed = chunk;
      if (!quick) {
        // Phase 1: a plain HTTP request through each proxy, many at once.
        const byTag = {};
        chunk.forEach((s, j) => { byTag[`${nonce}_${i + j}`] = proxyString(s); });
        await setTestPac({ byTag });
        const first = {};
        await Promise.all(chunk.map(async (s, j) => {
          first[s.id] = await timedFetch(`http://www.gstatic.com/generate_204?ogt=${nonce}_${i + j}`, 6000);
        }));
        passed = chunk.filter((s) => first[s.id]).sort((a, b) => first[a.id].ms - first[b.id].ms);
      }
      for (const s of chunk) results[s.id] = null;
      // Phase 2: a secure (HTTPS) page through each one that passed.
      for (let k = 0; k < passed.length; k += TRACE_HOSTS.length) {
        const round = passed.slice(k, k + TRACE_HOSTS.length);
        const byHost = {};
        round.forEach((s, j) => { byHost[TRACE_HOSTS[j]] = proxyString(s); });
        await setTestPac({ byHost });
        await Promise.all(round.map(async (s, j) => {
          const r = await timedFetch(`https://${TRACE_HOSTS[j]}/cdn-cgi/trace`, 8000, true);
          if (!r) return;
          const loc = (r.text.match(/^loc=([A-Z]{2})$/m) || [])[1] || '';
          results[s.id] = { ms: r.ms, code: loc === 'XX' ? '' : loc };
        }));
      }
      const working = Object.values(results).filter(Boolean).length;
      await onBatch?.(results, Math.min(i + CHUNK, servers.length), servers.length);
      if (working >= stopAfter || Date.now() - started > maxTime) break;
    }
  } finally {
    await restoreProxy();
    setTimeout(() => { testsRunning--; }, 1500); // late error events from the test
  }
  return results;
}

function withResult(s, r) {
  if (!r?.code) return s;
  return { ...s, code: r.code, flag: flagFromCode(r.code), country: countryName(r.code) };
}

// ---------- free servers: find, test, keep the fastest ----------
let refreshing = null;
async function refreshFree({ force = false } = {}) {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    const fs = await getFreeStatus();
    if (!force && fs.at && Date.now() - fs.at < 10 * 60 * 1000 && (await getFreeServers()).length >= 5) return fs;
    await setFreeStatus({ state: 'loading', error: '', progress: 0 });
    try {
      const { candidates, sourcesOk } = await fetchFreeProxies({ max: 1500 });
      const previous = await getFreeServers();
      if (!candidates.length && !previous.length) {
        throw new Error('Could not download the free server lists. Check your internet connection.');
      }
      // Servers that worked last time go first, so results come back fast.
      const prevIds = new Set(previous.map((p) => p.id));
      const pool = [...previous, ...candidates.filter((c) => !prevIds.has(c.id))];
      await setFreeStatus({ state: 'testing', found: pool.length, progress: 0, working: 0 });

      const save = async (results, done, total) => {
        const working = pool.filter((s) => results[s.id])
          .sort((a, b) => results[a.id].ms - results[b.id].ms)
          .slice(0, KEEP_FREE)
          .map((s) => withResult(s, results[s.id]));
        const pings = await getPings();
        for (const s of pool) if (s.id in results) delete pings[s.id];
        for (const s of working) pings[s.id] = { ms: results[s.id].ms, kind: 'real', at: Date.now() };
        // Keep not-yet-retested old servers until the new list is big enough.
        const keepOld = previous.filter((p) => !(p.id in results) && !working.some((w) => w.id === p.id));
        await set({ freeServers: [...working, ...keepOld].slice(0, KEEP_FREE), pings });
        await setFreeStatus({ progress: Math.round((done / total) * 100), working: working.length });
        return working;
      };
      let final = [];
      await testProxiesInBrowser(pool, {
        stopAfter: KEEP_FREE, maxTime: 4 * 60 * 1000,
        onBatch: async (results, done, total) => { final = await save(results, done, total); },
      });
      await addCountries(final);
      await set({ freeServers: final });
      const st = { state: 'idle', at: Date.now(), found: pool.length, working: final.length, sources: sourcesOk, error: '' };
      if (!final.length) st.error = 'No free server is answering right now. Tervyn will try again in a few minutes.';
      await setFreeStatus(st);
      // Move an active connection onto the fresh list.
      // (not awaited: connect() may itself be waiting for this refresh)
      const prefs = await getPrefs();
      if (final.length && prefs.enabled && prefs.selected === 'auto' && !connecting && (await getStatus()).usingFree) connect();
      return st;
    } catch (e) {
      await setFreeStatus({ state: 'idle', at: Date.now(), error: e.message || String(e) });
      throw e;
    }
  })();
  try { return await refreshing; } finally { refreshing = null; }
}

// Re-checks the servers in use; swaps out dead ones and tops up the list.
let checkingHealth = null;
async function healthCheck() {
  if (checkingHealth) return checkingHealth;
  checkingHealth = (async () => {
    const prefs = await getPrefs();
    const status = await getStatus();
    if (!prefs.enabled || status.state !== 'on' || !status.usingFree) return;
    if (refreshing || connecting) return; // a fresh list is on its way anyway
    const all = await getAllServers();
    const inUse = (status.servers || []).map((id) => all.find((s) => s.id === id)).filter(Boolean);
    if (!inUse.length) return;
    const res = await testProxiesInBrowser(inUse, { quick: true });
    const pings = await getPings();
    const now = Date.now();
    for (const s of inUse) pings[s.id] = { ms: res[s.id]?.ms ?? null, kind: 'real', at: now };
    await set({ pings });
    if (refreshing || connecting) return;
    const dead = inUse.filter((s) => !res[s.id]);
    if (prefs.selected !== 'auto') {
      // Auto-switch off: never change servers on our own, just tell the user.
      await setStatus({ warning: dead.length ? 'Your chosen server isn\'t answering. Pick another server or turn on Auto-switch.' : '' });
      return;
    }
    if (dead.length) {
      const alive = (s) => !dead.some((d) => d.id === s.id);
      await set({ freeServers: (await getFreeServers()).filter(alive), proxioServers: (await getProxioServers()).filter(alive) });
      if (!res[inUse[0].id]) await setStatus({ warning: 'A server stopped answering — switched to the next fastest one.' });
      await connect();
    }
    if (USER_KINDS.includes(prefs.source)) {
      const leftC = (await getUserServers(prefs.source)).filter((s) => pings[s.id]?.ms != null).length;
      if (!leftC && !userTesting[prefs.source]) testUser(prefs.source).catch(() => {});
      return;
    }
    if (prefs.source === 'proxio') {
      const leftP = (await getProxioServers()).filter((s) => pings[s.id]?.ms != null).length;
      const lastP = (await getProxioStatus()).at || 0;
      if (leftP < 3 && !proxioRefreshing && Date.now() - lastP > 5 * 60 * 1000) refreshProxio().catch(() => {});
      return;
    }
    const left = (await getFreeServers()).filter((s) => pings[s.id]?.ms != null).length;
    const lastSearch = (await getFreeStatus()).at || 0;
    if (left < 10 && !refreshing && Date.now() - lastSearch > 5 * 60 * 1000) refreshFree({ force: true }).catch(() => {});
  })();
  try { return await checkingHealth; } finally { checkingHealth = null; }
}

// ---------- Proxio.io servers (user's API key) ----------
let proxioRefreshing = null;
async function refreshProxio() {
  if (proxioRefreshing) return proxioRefreshing;
  proxioRefreshing = (async () => {
    const cfg = await getProxioConfig();
    if (!cfg.key) return { working: 0 };
    await setProxioStatus({ state: 'loading', error: '' });
    try {
      const list = await fetchProxio(cfg);
      // Chrome can't log in to SOCKS5 proxies, so those can't be used.
      const socksWithLogin = list.filter((s) => s.proto === 'socks5' && s.username);
      const usable = list.filter((s) => !(s.proto === 'socks5' && s.username));
      if (!usable.length) {
        throw new Error(socksWithLogin.length
          ? `Proxio.io sent ${socksWithLogin.length} SOCKS5 servers that need a password. Chrome can't use password-protected SOCKS5 — set the type to HTTP in Settings.`
          : 'Proxio.io returned no usable servers. Check your plan and the server type.');
      }
      await setProxioStatus({ state: 'testing', fetched: list.length });
      const res = await testProxiesInBrowser(usable);
      const working = usable.filter((s) => res[s.id]).sort((a, b) => res[a.id].ms - res[b.id].ms)
        .map((s) => withResult(s, res[s.id]));
      await addCountries(working);
      const pings = await getPings();
      for (const s of usable) pings[s.id] = res[s.id] ? { ms: res[s.id].ms, kind: 'real', at: Date.now() } : { ms: null, kind: 'real', at: Date.now() };
      await set({ proxioServers: working, pings });
      const st = { state: 'idle', at: Date.now(), fetched: list.length, working: working.length, skipped: socksWithLogin.length, error: '' };
      if (!working.length) st.error = `Proxio.io sent ${usable.length} servers, but none answered the speed test. Try again in a few minutes.`;
      await setProxioStatus(st);
      const prefs = await getPrefs();
      if (working.length && prefs.enabled && prefs.source !== 'free' && prefs.selected === 'auto' && !connecting && (await getStatus()).usingFree) connect();
      return st;
    } catch (e) {
      await setProxioStatus({ state: 'idle', at: Date.now(), error: e.message || String(e) });
      throw e;
    }
  })();
  try { return await proxioRefreshing; } finally { proxioRefreshing = null; }
}

// ---------- My proxies (curl / Python / Node.js integration) ----------
const userTesting = {};
async function testUser(kind) {
  if (userTesting[kind]) return userTesting[kind];
  userTesting[kind] = (async () => {
    const list = await getUserServers(kind);
    if (!list.length) return { working: 0, total: 0 };
    await setUserStatus(kind, { state: 'testing', error: '', total: list.length });
    try {
      const res = await testProxiesInBrowser(list);
      const pings = await getPings();
      const now = Date.now();
      const updated = list.map((s) => {
        pings[s.id] = { ms: res[s.id]?.ms ?? null, kind: 'real', at: now };
        return res[s.id]?.code ? withCountry(s, res[s.id].code) : s;
      });
      await set({ [`${kind}Servers`]: updated, pings });
      const working = updated.filter((s) => res[s.id]).length;
      const socksLogin = updated.filter((s) => s.proto === 'socks5' && s.username).length;
      const st = { state: 'idle', at: now, total: updated.length, working, error: '' };
      if (!working) {
        st.error = socksLogin
          ? 'Chrome can\'t log in to SOCKS5 proxies that need a password. Use the HTTP version of your proxies (most providers offer both).'
          : `${updated.length === 1 ? 'Your proxy' : 'None of your proxies'} answered. Check the address, port, username and password, and that your plan is active.`;
      }
      await setUserStatus(kind, st);
      const prefs = await getPrefs();
      if (working && prefs.enabled && prefs.source === kind && prefs.selected === 'auto' && !connecting && (await getStatus()).usingFree) connect();
      return st;
    } catch (e) {
      await setUserStatus(kind, { state: 'idle', at: Date.now(), error: e.message || String(e) });
      throw e;
    }
  })();
  try { return await userTesting[kind]; } finally { userTesting[kind] = null; }
}

async function removeUserServer(kind, id) {
  const before = await getPrefs();
  const removed = (await getUserServers(kind)).filter((x) => !id || x.id === id).map((x) => x.id);
  if (removed.includes(before.selected)) await handlers.setPrefs({ patch: { selected: 'auto' } });
  const left = id ? (await getUserServers(kind)).filter((x) => x.id !== id) : [];
  await set({ [`${kind}Servers`]: left });
  if (!left.length) {
    await chrome.storage.local.remove([`${kind}Status`, `${kind}Info`]);
    const prefs = await getPrefs();
    if (prefs.source === kind) await handlers.setPrefs({ patch: { source: 'free', selected: 'auto' } });
  }
  return true;
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
      for (const s of direct) pings[s.id] = { ms: ms[s.id]?.ms ?? null, kind: 'real', at: now };
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
    // Auto-switch off: stay on the chosen server, even if it left the free list.
    const s = all.find((x) => x.id === prefs.selected) || (prefs.pinned?.id === prefs.selected ? prefs.pinned : null);
    if (s) return { servers: [s], core: s.kind === 'core' };
    if (!prefs.autoSwitch) throw new Error('Your chosen server is no longer available. Pick another server or turn on Auto-switch.');
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

  // My proxies (pasted curl / Python / Node.js / lists). Never thrown away:
  // dead ones are just skipped until the next test.
  if (USER_KINDS.includes(prefs.source)) {
    const kind = prefs.source;
    const mine = await getUserServers(kind);
    if (!mine.length) throw new Error(kind === 'list' ? 'Import your proxy list file in Settings → Proxy list file first.' : 'Add your proxy in Settings → My proxies first.');
    let list = mine.filter(works);
    if (!list.length) {
      await testUser(kind).catch(() => {});
      const p2 = await getPings();
      list = (await getUserServers(kind)).filter((s) => p2[s.id]?.ms != null);
    }
    if (!list.length) {
      const st = await getUserStatus(kind);
      throw new Error(st.error || 'None of your proxies answered. Check the address, port, username and password.');
    }
    return { servers: rank(inCountry(list), await getPings()).slice(0, Math.max(2, prefs.autoPool)), core: false };
  }

  // Proxio.io servers (with the user's API key).
  if (prefs.source === 'proxio') {
    let list = (await getProxioServers()).filter(works);
    if (!list.length) {
      await refreshProxio().catch(() => {});
      const p2 = await getPings();
      list = (await getProxioServers()).filter((s) => p2[s.id]?.ms != null);
    }
    if (!list.length) {
      const st = await getProxioStatus();
      throw new Error(st.error || 'No working Proxio.io server right now. Check your API key in Settings, or switch the server source to free servers.');
    }
    return { servers: rank(inCountry(list), await getPings()).slice(0, Math.max(2, prefs.autoPool)), core: false };
  }

  // Otherwise: free servers (no setup), plus any plain proxies you added
  // (and Proxio.io servers when the source is "both").
  const useProxio = prefs.source === 'both';
  const freeNow = async () => [
    ...(useProxio ? await getProxioServers() : []),
    ...(await getFreeServers()), ...(await getOwnServers()).filter((s) => s.kind === 'direct'),
  ].filter((s) => (pingsNow[s.id]?.ms != null));
  let pingsNow = pings;
  let free = await freeNow();
  // Running low: top up in the background (at most every 5 minutes, to avoid endless re-testing).
  const lastSearch = (await getFreeStatus()).at || 0;
  if (free.length < 3 && !refreshing && Date.now() - lastSearch > 5 * 60 * 1000) refreshFree({ force: true }).catch(() => {});
  if (!free.length) {
    // Nothing yet: wait for the search and connect as soon as servers show up.
    const search = (refreshing || refreshFree({ force: true })).catch(() => {});
    const deadline = Date.now() + 180000;
    let finished = false;
    search.then(() => { finished = true; });
    let firstFoundAt = 0;
    while (Date.now() < deadline) {
      pingsNow = await getPings();
      free = await freeNow();
      if (free.length && !firstFoundAt) firstFoundAt = Date.now();
      // Connect with 2+ servers (one is a backup), or with 1 after a short wait.
      if (free.length >= 2 || finished || (firstFoundAt && Date.now() - firstFoundAt > 6000)) break;
      await sleep(1000);
    }
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
  const before = await getStatus();
  // Switching servers while on: keep showing "on" (traffic keeps flowing).
  if (before.state !== 'on') await setStatus({ state: 'connecting', error: '', warning: '' });
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
// Chrome already skips a dead server in the chain. If errors keep coming,
// re-check the servers in use and swap out the dead ones.
let errorTimes = [];
chrome.proxy.onProxyError.addListener(async (details) => {
  if (testsRunning > 0) return; // failed test requests are expected
  const prefs = await getPrefs();
  const status = await getStatus();
  if (!prefs.enabled || status.state !== 'on') return;
  if (!/PROXY|SOCKS|TUNNEL/.test(details.error)) return;
  const now = Date.now();
  errorTimes = errorTimes.filter((t) => now - t < 20000);
  errorTimes.push(now);
  if (errorTimes.length < 3) return;
  errorTimes = [];
  if (status.usingFree) healthCheck().catch(() => {});
  else await setStatus({ warning: `Can't reach the VPN (${details.error}). Try another server.` });
});

// Logins for plain HTTP/SOCKS proxies you added that need a username.
const authTried = new Set();
chrome.webRequest.onAuthRequired.addListener(
  (details, callback) => {
    if (!details.isProxy) { callback({}); return; }
    // Answer once per request: if Chrome asks again, the login was wrong — stop.
    if (authTried.has(details.requestId)) { callback({ cancel: true }); return; }
    authTried.add(details.requestId);
    setTimeout(() => authTried.delete(details.requestId), 60000);
    getAllServers().then((all) => {
      const c = details.challenger || {};
      const s = all.find((x) => x.username && x.address === c.host && Number(x.port) === Number(c.port));
      callback(s ? { authCredentials: { username: s.username, password: s.password } } : {});
    }).catch(() => callback({}));
  },
  { urls: ['<all_urls>'] },
  ['asyncBlocking'],
);

// ---------- lifecycle ----------
function scheduleAlarms() {
  chrome.alarms.create('refresh', { periodInMinutes: FREE_REFRESH_MIN });
  chrome.alarms.create('health', { periodInMinutes: 2 });
}

chrome.runtime.onInstalled.addListener(async () => {
  scheduleAlarms();
  await updateBadge();
  refreshFree({ force: true }).catch(() => {}); // find free servers right away
});

chrome.runtime.onStartup.addListener(async () => {
  scheduleAlarms();
  const prefs = await getPrefs();
  if (prefs.enabled) await connect();
  else await updateBadge();
  refreshFree().catch(() => {});
});

chrome.alarms.onAlarm.addListener(async (a) => {
  if (a.name === 'health') {
    await healthCheck().catch(() => {});
  } else if (a.name === 'refresh') {
    await refreshListUrls();
    const src = (await getPrefs()).source;
    if (src === 'proxio' || src === 'both') await refreshProxio().catch(() => {});
    if (src === 'free' || src === 'both') await refreshFree({ force: true }).catch(() => {});
  }
});

// Chrome can stop this background script at any time. If that happened in
// the middle of a test or a connect, put things back in a clean state.
(async () => {
  const fs = await getFreeStatus();
  const status = await getStatus();
  if (!refreshing && (fs.state === 'loading' || fs.state === 'testing')) {
    await setFreeStatus({ state: 'idle' });
    await restoreProxy();
  }
  if (!connecting && status.state === 'connecting') {
    const prefs = await getPrefs();
    const { activeProxy } = await get('activeProxy');
    await setStatus({ state: prefs.enabled && activeProxy ? 'on' : 'off' });
    await restoreProxy();
    await updateBadge();
  }
})();

const handlers = {
  async state() {
    const [prefs, status, servers, sources, pings, freeStatus, proxioCfg, proxioStatus, customStatus, listStatus] = await Promise.all(
      [getPrefs(), getStatus(), getAllServers(), getSources(), getPings(), getFreeStatus(), getProxioConfig(), getProxioStatus(), getUserStatus('custom'), getUserStatus('list')]);
    const custom = { ...customStatus, busy: !!userTesting.custom };
    const list = { ...((await get('listInfo')).listInfo || {}), ...listStatus, busy: !!userTesting.list };
    const proxio = { hasKey: !!proxioCfg.key, keyHint: proxioCfg.key ? '••••' + proxioCfg.key.slice(-4) : '', type: proxioCfg.type || 'socks5', limit: proxioCfg.limit || 50, ...proxioStatus, busy: !!proxioRefreshing };
    return { prefs, status, servers, sources, pings, freeStatus, proxio, custom, list, refreshing: !!refreshing, testing: !!testing };
  },
  connect: () => connect(),
  disconnect: () => disconnect(),
  async setPrefs({ patch }) {
    const before = await getPrefs();
    patch = { ...patch };
    if ('autoSwitch' in patch && !('selected' in patch)) {
      if (patch.autoSwitch) patch.selected = 'auto';
      else {
        // Turning auto-switch off: stay on the server in use (or the fastest one now).
        const status = await getStatus();
        const all = await getAllServers();
        let s = before.enabled && status.state === 'on' ? all.find((x) => x.id === status.servers?.[0]) : null;
        if (!s) s = (await pickServers({ ...before, selected: 'auto', autoSwitch: true }).catch(() => ({ servers: [] }))).servers[0];
        if (!s) throw new Error('No working server to stay on yet. Connect once first, or pick a server in the Servers tab.');
        patch.selected = s.id;
      }
    }
    if ('selected' in patch) {
      if (patch.selected === 'auto') Object.assign(patch, { autoSwitch: true, pinned: null });
      else {
        const s = (await getAllServers()).find((x) => x.id === patch.selected);
        Object.assign(patch, { autoSwitch: false, pinned: s || before.pinned });
      }
    }
    // Changing source or country while pinned: go back to auto so the change takes effect.
    if (('source' in patch && patch.source !== before.source) || ('country' in patch && patch.country !== before.country)) {
      if (!('selected' in patch) && before.selected !== 'auto') Object.assign(patch, { selected: 'auto', autoSwitch: true, pinned: null });
    }
    const prefs = await savePrefs(patch);
    const needsReconnect = prefs.enabled && ['selected', 'country', 'autoPool', 'socksPort', 'httpPort', 'manualCore', 'source', 'autoSwitch']
      .some((k) => k in patch && patch[k] !== before[k]);
    if (needsReconnect) {
      await setStatus({ warning: '' }); // old warnings were about the previous server
      await connect();
    }
    else if ('mode' in patch || 'bypass' in patch) await refreshProxyIfOn();
    return prefs;
  },
  ensureFree: async () => {
    const prefs = await getPrefs();
    if (prefs.source === 'free' || prefs.source === 'both') refreshFree().catch(() => {});
    return true;
  },
  async proxioSave({ key, proxyType, limit }) {
    const old = await getProxioConfig();
    const cfg = { key: (key || old.key || '').trim(), type: proxyType || old.type || 'socks5', limit: Number(limit) || old.limit || 50 };
    if (!cfg.key) throw new Error('Enter your Proxio.io API key first.');
    await set({ proxio: cfg });
    const st = await refreshProxio();
    const prefs = await getPrefs();
    if (prefs.source === 'free' && st.working) await handlers.setPrefs({ patch: { source: 'proxio', selected: 'auto' } });
    return st;
  },
  proxioRefresh: () => refreshProxio(),
  async customSave({ text, replace = true }) {
    const { servers, skipped } = extractProxies(text);
    if (!servers.length) {
      throw new Error(skipped
        ? 'That proxy type can\'t be used in Chrome (only HTTP and SOCKS5 work).'
        : 'No proxy found. Paste a curl / Python / Node.js example, a proxy URL like http://user:pass@1.2.3.4:6014, or lines like ip:port:user:pass.');
    }
    const old = replace ? [] : await getUserServers('custom');
    const merged = [...new Map([...old, ...servers].map((x) => [x.id, x])).values()];
    await set({ customServers: merged });
    const st = await testUser('custom');
    const prefs = await getPrefs();
    if (st.working && prefs.source !== 'custom') await handlers.setPrefs({ patch: { source: 'custom', selected: 'auto' } });
    return { ...st, added: servers.length };
  },
  customTest: () => testUser('custom'),
  customRemove: ({ id }) => removeUserServer('custom', id),
  async listSave({ text, proto, fileName }) {
    const { servers, bad } = parseProxyListFile(text, proto === 'socks5' ? 'socks5' : 'http');
    if (!servers.length) {
      throw new Error('No proxies found in this file. Each line should look like ip:port:username:password (or ip:port).');
    }
    await set({ listServers: servers, listInfo: { fileName: fileName || 'Proxy list', proto, count: servers.length, bad, at: Date.now() } });
    const st = await testUser('list');
    const prefs = await getPrefs();
    if (st.working && prefs.source !== 'list') await handlers.setPrefs({ patch: { source: 'list', selected: 'auto' } });
    return { ...st, added: servers.length, bad };
  },
  listTest: () => testUser('list'),
  async listSetProto({ proto }) {
    const mine = await getUserServers('list');
    if (!mine.length) return true;
    const text = mine.map((x) => [x.address, x.port, x.username, x.password].filter((v, i) => i < 2 || x.username).join(':')).join('\n');
    const info = (await get('listInfo')).listInfo || {};
    return handlers.listSave({ text, proto, fileName: info.fileName });
  },
  listRemove: ({ id }) => removeUserServer('list', id),
  async proxioRemove() {
    await chrome.storage.local.remove(['proxio', 'proxioServers', 'proxioStatus']);
    const prefs = await getPrefs();
    if (prefs.source !== 'free') await handlers.setPrefs({ patch: { source: 'free', selected: 'auto' } });
    return true;
  },
  async test() {
    const prefs = await getPrefs();
    if (prefs.source === 'proxio') return refreshProxio();
    if (USER_KINDS.includes(prefs.source)) return testUser(prefs.source);
    if (prefs.source === 'both') await refreshProxio().catch(() => {});
    return testAll();
  },
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
