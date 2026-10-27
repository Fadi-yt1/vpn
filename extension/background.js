import { parseSubscription, hashId } from './lib/links.js';
import { buildConfig, toOutbound } from './lib/xray.js';
import { buildPac, proxyString, normalizeSite, IP_CHECK_HOST } from './lib/pac.js';

const HOST = 'com.opengate.vpn';
const HELPER_MISSING = 'These servers need the free OpenGate helper (one-time setup). Open Settings for the 1-minute install.';

const DEFAULT_PREFS = {
  enabled: false,
  mode: 'full',            // 'full' = all sites, 'targeted' = only listed sites
  selected: 'auto',        // 'auto' or a server id
  sites: [],
  socksPort: 10808,
  httpPort: 10809,
  autoPool: 8,             // how many of the fastest servers the auto mode balances between
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
async function getServers() { return (await get('servers')).servers || []; }
async function getSources() { return (await get('sources')).sources || []; }
async function getPings() { return (await get('pings')).pings || {}; }
async function getStatus() { return (await get('status')).status || {}; }
async function setStatus(patch) {
  const status = { ...(await getStatus()), ...patch };
  await set({ status });
  return status;
}

// ---------- native helper ----------
async function native(msg) {
  try {
    const res = await chrome.runtime.sendNativeMessage(HOST, msg);
    return res || { ok: false, error: 'Empty reply from helper' };
  } catch (e) {
    return { ok: false, missing: true, error: String(e.message || e) };
  }
}

// ---------- sources / import ----------
async function importText(text, source) {
  const { servers, meta, skipped } = parseSubscription(text);
  if (!servers.length) throw new Error('No usable servers found in this text/file.');
  const all = (await getServers()).filter((s) => s.sourceId !== source.id);
  for (const s of servers) s.sourceId = source.id;
  await set({ servers: [...all, ...servers] });

  const sources = (await getSources()).filter((s) => s.id !== source.id);
  sources.push({
    ...source,
    name: source.name || meta['profile-title'] || (source.url ? new URL(source.url).hostname : 'Imported list'),
    count: servers.length,
    skipped,
    updatedAt: Date.now(),
    announce: meta.announce || '',
  });
  await set({ sources });
  return { added: servers.length, skipped };
}

async function fetchSubscription(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`Download failed (${res.status})`);
  return res.text();
}

async function addSubscription(url) {
  const text = await fetchSubscription(url);
  return importText(text, { id: hashId(url), type: 'url', url });
}

async function refreshSubscriptions() {
  const sources = (await getSources()).filter((s) => s.type === 'url');
  const results = [];
  for (const src of sources) {
    try {
      results.push(await importText(await fetchSubscription(src.url), src));
    } catch (e) {
      results.push({ error: `${src.name}: ${e.message}` });
    }
  }
  return results;
}

async function removeSource(id) {
  await set({
    servers: (await getServers()).filter((s) => s.sourceId !== id),
    sources: (await getSources()).filter((s) => s.id !== id),
  });
  const prefs = await getPrefs();
  if (prefs.selected !== 'auto' && !(await getServers()).some((s) => s.id === prefs.selected)) {
    await savePrefs({ selected: 'auto' });
  }
}

// ---------- speed test ----------
// Rough latency without the helper: time how long the server takes to answer
// (or refuse) a request. Only a hint; the helper does a real test.
async function roughPing(host, port, timeout = 3000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  const start = performance.now();
  try {
    const h = host.includes(':') ? `[${host}]` : host;
    await fetch(`https://${h}:${port}/`, { mode: 'no-cors', cache: 'no-store', credentials: 'omit', signal: ctl.signal });
  } catch {
    if (ctl.signal.aborted) return null;
  } finally {
    clearTimeout(timer);
  }
  return Math.round(performance.now() - start);
}

async function runPool(items, limit, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const item = items[i++]; await fn(item); }
  });
  await Promise.all(workers);
}

let testing = null;
async function testServers(onlyIds) {
  if (testing) return testing;
  testing = (async () => {
    let servers = await getServers();
    if (onlyIds) servers = servers.filter((s) => onlyIds.includes(s.id));
    const pings = await getPings();
    const now = Date.now();
    const core = servers.filter((s) => s.kind === 'core');
    const direct = servers.filter((s) => s.kind === 'direct');
    let method = 'rough';

    if (core.length) {
      // Step 1: quick TCP check per host, so dead servers are skipped fast.
      const hostOf = (s) => `${s.address}:${s.port}`;
      const hosts = [...new Map(core.map((s) => [hostOf(s), s])).values()];
      const tcp = await native({ cmd: 'tcpping', items: hosts.map((s) => ({ key: hostOf(s), host: s.address, port: s.port })), timeout: 3 });
      if (tcp.ok) {
        // Step 2: real test (an actual request through each reachable server).
        const reachable = core.filter((s) => tcp.results[hostOf(s)] != null);
        const items = reachable.map((s, i) => ({ key: s.id, outbound: toOutbound(s, `t${i}`) }));
        const res = items.length
          ? await native({ cmd: 'realtest', items, timeout: 5, url: 'http://www.gstatic.com/generate_204' })
          : { ok: true, results: {} };
        method = 'real';
        for (const s of core) pings[s.id] = { ms: res.ok ? res.results[s.id] ?? null : null, kind: 'real', at: now };
      } else {
        // No helper: rough test per unique host:port.
        const byHost = new Map();
        for (const s of core) byHost.set(`${s.address}:${s.port}`, s);
        const hostMs = {};
        await runPool([...byHost.keys()], 24, async (hp) => {
          const s = byHost.get(hp);
          hostMs[hp] = await roughPing(s.address, s.port);
        });
        for (const s of core) pings[s.id] = { ms: hostMs[`${s.address}:${s.port}`], kind: 'rough', at: now };
      }
    }
    if (direct.length) {
      const res = await native({ cmd: 'tcpping', items: direct.map((s) => ({ key: s.id, host: s.address, port: s.port })), timeout: 3 });
      for (const s of direct) {
        const ms = res.ok ? res.results[s.id] : await roughPing(s.address, s.port);
        pings[s.id] = { ms: ms ?? null, kind: res.ok ? 'tcp' : 'rough', at: now };
      }
    }
    await set({ pings });
    return { method, tested: servers.length, working: servers.filter((s) => pings[s.id]?.ms != null).length };
  })();
  try { return await testing; } finally { testing = null; }
}

function rank(servers, pings) {
  const score = (s) => {
    const p = pings[s.id];
    if (!p) return 50000;                 // untested
    if (p.ms == null) return 100000;      // failed
    return p.ms + (p.kind === 'real' ? 0 : 1000);
  };
  return [...servers].sort((a, b) => score(a) - score(b));
}

async function pickServers(prefs) {
  const servers = await getServers();
  if (prefs.selected !== 'auto') {
    const s = servers.find((x) => x.id === prefs.selected);
    if (s) return [s];
  }
  let pool = servers.filter((s) => s.kind === 'core');
  if (!pool.length) pool = servers; // only plain HTTP/SOCKS proxies imported
  if (prefs.country) {
    const inCountry = pool.filter((s) => s.country === prefs.country);
    if (inCountry.length) pool = inCountry;
  }
  let pings = await getPings();
  if (!pool.some((s) => pings[s.id])) {
    // Never tested: test a sample of hosts so the first connect is quick.
    const seen = new Set();
    const sample = pool.filter((s) => {
      const k = `${s.address}:${s.port}`;
      if (seen.has(k) || seen.size >= 60) return false;
      seen.add(k);
      return true;
    });
    await testServers(sample.map((s) => s.id));
    pings = await getPings();
  }
  const ranked = rank(pool, pings).filter((s) => pings[s.id]?.ms != null);
  const best = (ranked.length ? ranked : pool).slice(0, Math.max(1, prefs.autoPool));
  if (best[0]?.kind === 'direct') return [best[0]];
  return best.filter((s) => s.kind === 'core');
}

// ---------- proxy control ----------
let activeDirect = null; // direct proxy in use (for proxy auth)

async function applyProxy(prefs, server) {
  const pac = buildPac({
    mode: prefs.mode,
    sites: prefs.sites,
    bypass: prefs.bypass,
    proxy: proxyString(server, prefs.socksPort),
  });
  await chrome.proxy.settings.set({ value: { mode: 'pac_script', pacScript: { data: pac } }, scope: 'regular' });
}

async function connect() {
  const prefs = await savePrefs({ enabled: true });
  await setStatus({ state: 'connecting', error: '', warning: '' });
  try {
    if (prefs.mode === 'targeted' && !prefs.sites.length) {
      throw new Error('Targeted mode is on but your site list is empty. Add a site first.');
    }
    const all = await getServers();
    const chosen = all.find((s) => s.id === prefs.selected);
    const needsCore = chosen ? chosen.kind === 'core' : all.some((s) => s.kind === 'core');
    if (needsCore && !prefs.manualCore) {
      const h = await native({ cmd: 'status' });
      if (!h.ok) throw new Error(h.missing ? HELPER_MISSING : `Helper error: ${h.error}`);
    }
    let servers = await pickServers(prefs);
    if (!servers.length) throw new Error('No servers yet. Import your server list in the Servers tab.');

    let label;
    if (servers[0].kind === 'direct') {
      activeDirect = servers[0];
      await native({ cmd: 'stop' });
      label = servers[0].name;
    } else {
      activeDirect = null;
      if (!prefs.manualCore) {
        let res = await native({ cmd: 'start', config: buildConfig(servers, prefs) });
        if (!res.ok && servers.length > 1 && !res.missing) {
          // One bad server can break the whole auto config; fall back to the best one.
          servers = servers.slice(0, 1);
          res = await native({ cmd: 'start', config: buildConfig(servers, prefs) });
        }
        if (!res.ok) {
          throw new Error(res.missing ? HELPER_MISSING : `Helper error: ${res.error}`);
        }
      }
      label = servers.length > 1 ? `Auto · fastest of ${servers.length}` : servers[0].name;
    }
    await applyProxy(prefs, activeDirect);
    await set({ activeDirect });
    await setStatus({ state: 'on', label, servers: servers.map((s) => s.id), since: Date.now(), error: '' });
  } catch (e) {
    await savePrefs({ enabled: false });
    await chrome.proxy.settings.clear({ scope: 'regular' });
    await setStatus({ state: 'off', error: e.message || String(e) });
  }
  await updateBadge();
  return getStatus();
}

async function disconnect() {
  await savePrefs({ enabled: false });
  await chrome.proxy.settings.clear({ scope: 'regular' });
  activeDirect = null;
  await set({ activeDirect: null });
  const prefs = await getPrefs();
  if (!prefs.manualCore) await native({ cmd: 'stop' });
  await setStatus({ state: 'off', error: '', warning: '', label: '' });
  await updateBadge();
  return getStatus();
}

// Re-applies the PAC script when the site list or mode changes.
async function refreshProxyIfOn() {
  const prefs = await getPrefs();
  if (!prefs.enabled) return;
  if (prefs.mode === 'targeted' && !prefs.sites.length) return;
  const { activeDirect: d } = await get('activeDirect');
  await applyProxy(prefs, d || null);
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

// ---------- events ----------
chrome.runtime.onInstalled.addListener(async () => {
  chrome.alarms.create('refresh-subs', { periodInMinutes: 60 });
  await updateBadge();
});

chrome.runtime.onStartup.addListener(async () => {
  const prefs = await getPrefs();
  if (prefs.enabled) await connect();
  else await updateBadge();
});

chrome.alarms.onAlarm.addListener(async (a) => {
  if (a.name !== 'refresh-subs') return;
  await refreshSubscriptions();
});

chrome.proxy.onProxyError.addListener(async (details) => {
  const prefs = await getPrefs();
  if (!prefs.enabled) return;
  if (/PROXY_CONNECTION_FAILED|SOCKS_CONNECTION_FAILED|TUNNEL_CONNECTION_FAILED/.test(details.error)) {
    await setStatus({ warning: `Can't reach the VPN (${details.error}). Try another server or run a speed test.` });
  }
});

// Credentials for direct HTTP/SOCKS proxies that need a login.
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

const handlers = {
  async state() {
    const [prefs, status, servers, sources, pings] = await Promise.all([getPrefs(), getStatus(), getServers(), getSources(), getPings()]);
    return { prefs, status, servers, sources, pings, testing: !!testing };
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
  importText: ({ text, name }) => importText(text, { id: hashId('paste:' + (name || '') + Date.now()), type: 'paste', name }),
  addSubscription: ({ url }) => addSubscription(url),
  refreshSubscriptions: () => refreshSubscriptions(),
  removeSource: ({ id }) => removeSource(id),
  test: ({ ids }) => testServers(ids),
  addSites: ({ sites }) => addSites(sites),
  removeSites: ({ sites }) => removeSites(sites),
  helperStatus: () => native({ cmd: 'status' }),
  async exportConfig() {
    const prefs = await getPrefs();
    const servers = (await pickServers(prefs)).filter((s) => s.kind === 'core');
    if (!servers.length) throw new Error('No Xray servers to export.');
    return buildConfig(servers, prefs);
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
