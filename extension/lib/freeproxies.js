// Downloads free public proxy servers from several open lists, so the
// extension works with zero setup. Lists are merged and de-duplicated;
// the background script then tests them and keeps only working ones.

import { hashId } from './links.js';

// type: 'json' = any JSON with ip/port objects, 'text' = one proxy per line.
// proto: protocol to assume when a line has none.
// weight: how much we trust the list (lists that re-check their proxies often score higher).
const GH = 'https://raw.githubusercontent.com/';
export const FREE_SOURCES = [
  { name: 'jetkai (online)', type: 'text', proto: 'socks5', weight: 3, url: GH + 'jetkai/proxy-list/main/online-proxies/txt/proxies-socks5.txt' },
  { name: 'jetkai HTTP (online)', type: 'text', proto: 'http', weight: 2, url: GH + 'jetkai/proxy-list/main/online-proxies/txt/proxies-http.txt' },
  { name: 'monosans', type: 'text', proto: 'socks5', weight: 3, url: GH + 'monosans/proxy-list/main/proxies/socks5.txt' },
  { name: 'monosans HTTP', type: 'text', proto: 'http', weight: 2, url: GH + 'monosans/proxy-list/main/proxies/http.txt' },
  { name: 'elliottophellia (checked)', type: 'text', proto: 'socks5', weight: 3, url: GH + 'elliottophellia/proxylist/master/results/socks5/global/socks5_checked.txt' },
  { name: 'roosterkid', type: 'text', proto: 'socks5', weight: 3, url: GH + 'roosterkid/openproxylist/main/SOCKS5_RAW.txt' },
  { name: 'roosterkid HTTPS', type: 'text', proto: 'http', weight: 3, url: GH + 'roosterkid/openproxylist/main/HTTPS_RAW.txt' },
  { name: 'vakhov', type: 'text', proto: 'socks5', weight: 3, url: GH + 'vakhov/fresh-proxy-list/master/socks5.txt' },
  { name: 'vakhov HTTPS', type: 'text', proto: 'http', weight: 3, url: GH + 'vakhov/fresh-proxy-list/master/https.txt' },
  { name: 'prxchk', type: 'text', proto: 'socks5', weight: 3, url: GH + 'prxchk/proxy-list/main/socks5.txt' },
  { name: 'sunny9577', type: 'text', proto: 'socks5', weight: 2, url: GH + 'sunny9577/proxy-scraper/master/generated/socks5_proxies.txt' },
  { name: 'hideip.me', type: 'text', proto: 'socks5', weight: 2, url: GH + 'zloi-user/hideip.me/main/socks5.txt' },
  { name: 'Zaeem20', type: 'text', proto: 'socks5', weight: 2, url: GH + 'Zaeem20/FREE_PROXIES_LIST/master/socks5.txt' },
  { name: 'TheSpeedX', type: 'text', proto: 'socks5', weight: 1, url: GH + 'TheSpeedX/PROXY-List/master/socks5.txt' },
  { name: 'Proxifly HTTPS', type: 'text', proto: 'http', weight: 2, url: GH + 'proxifly/free-proxy-list/main/proxies/protocols/https/data.txt' },
  { name: 'Proxifly SOCKS5', type: 'text', proto: 'socks5', weight: 1, url: GH + 'proxifly/free-proxy-list/main/proxies/protocols/socks5/data.txt' },
  { name: 'ProxyScrape', type: 'json', weight: 2, url: 'https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&proxy_format=protocolipport&format=json' },
  { name: 'Geonode', type: 'json', weight: 2, url: 'https://proxylist.geonode.com/api/proxy-list?limit=500&page=1&sort_by=lastChecked&sort_type=desc' },
];

// Lines from huge lists are mostly dead; only read this many per list.
const MAX_PER_SOURCE = 3000;

const IP_RE = /^\d{1,3}(\.\d{1,3}){3}$/;
const regionNames = (() => { try { return new Intl.DisplayNames(['en'], { type: 'region' }); } catch { return null; } })();

export function flagFromCode(code) {
  if (!/^[A-Z]{2}$/i.test(code || '')) return '🌐';
  return [...code.toUpperCase()].map((c) => String.fromCodePoint(0x1f1e6 + c.charCodeAt(0) - 65)).join('');
}
export function countryName(code) {
  if (!/^[A-Z]{2}$/i.test(code || '')) return 'Unknown';
  try { return regionNames?.of(code.toUpperCase()) || code.toUpperCase(); } catch { return code.toUpperCase(); }
}

function normProto(p) {
  p = String(p || '').toLowerCase();
  if (p === 'socks5' || p === 'socks5h' || p === 'socks') return 'socks5';
  if (p === 'http' || p === 'https') return 'http'; // "https" in these lists = HTTP proxy that supports HTTPS sites
  return null; // socks4 etc. are skipped (no remote DNS, leaks and often blocked)
}

function makeServer(proto, ip, port, code, source) {
  proto = normProto(proto);
  port = Number(port);
  if (!proto || !IP_RE.test(ip) || !(port > 0 && port < 65536)) return null;
  code = /^[A-Z]{2}$/i.test(code || '') ? code.toUpperCase() : '';
  const key = `${proto}://${ip}:${port}`;
  return {
    id: hashId(key), kind: 'direct', proto, address: ip, port,
    code, flag: flagFromCode(code), country: countryName(code),
    name: `${proto.toUpperCase()} ${ip}:${port}`, link: key,
    sourceId: 'free', source, supported: true, free: true,
  };
}

const pick = (o, ...keys) => { for (const k of keys) if (o[k] != null && o[k] !== '') return o[k]; return undefined; };

// Walks any JSON shape and turns objects that look like proxies into servers.
export function fromJson(data, source) {
  const out = [];
  const walk = (v, depth) => {
    if (depth > 4 || v == null) return;
    if (Array.isArray(v)) { for (const x of v) walk(x, depth + 1); return; }
    if (typeof v !== 'object') return;
    const ip = pick(v, 'ip', 'host', 'address');
    const port = pick(v, 'port');
    if (ip && port) {
      let protos = pick(v, 'protocols', 'protocol', 'type');
      if (!protos && typeof v.proxy === 'string') protos = v.proxy.split('://')[0];
      protos = Array.isArray(protos) ? protos : [protos];
      const geo = v.geolocation || v.ip_data || v.location || {};
      const code = pick(v, 'countryCode', 'country_code') || pick(geo, 'countryCode', 'country_code', 'country') || v.country;
      for (const p of protos) {
        const s = makeServer(p, String(ip), port, typeof code === 'string' ? code : '', source);
        if (s) out.push(s);
      }
      return;
    }
    for (const x of Object.values(v)) walk(x, depth + 1);
  };
  walk(data, 0);
  return out;
}

export function fromText(text, source, defaultProto) {
  const out = [];
  const re = /(?:(https?|socks[45]h?):\/\/)?(\d{1,3}(?:\.\d{1,3}){3}):(\d{2,5})/i;
  for (const line of text.split(/\r?\n/, MAX_PER_SOURCE)) {
    const m = line.match(re);
    if (!m) continue;
    const s = makeServer(m[1] || defaultProto, m[2], m[3], '', source);
    if (s) out.push(s);
  }
  return out;
}

async function fetchWithTimeout(url, ms) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const res = await fetch(url, { cache: 'no-store', signal: ctl.signal, credentials: 'omit' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}

// Returns de-duplicated candidates, most promising first: proxies that several
// trusted lists agree on are usually alive.
export async function fetchFreeProxies({ max = 1500 } = {}) {
  const results = await Promise.allSettled(FREE_SOURCES.map(async (src) => {
    const text = await fetchWithTimeout(src.url, 25000);
    if (src.type === 'json') {
      try { return fromJson(JSON.parse(text), src.name); } catch { return fromText(text, src.name, 'http'); }
    }
    return fromText(text, src.name, src.proto);
  }));
  const byKey = new Map();
  const sourcesOk = [];
  results.forEach((r, i) => {
    if (r.status !== 'fulfilled' || !r.value.length) return;
    const src = FREE_SOURCES[i];
    sourcesOk.push(src.name);
    for (const s of r.value) {
      const prev = byKey.get(s.id);
      if (!prev) byKey.set(s.id, { ...s, score: src.weight });
      else {
        prev.score += src.weight;
        if (!prev.code && s.code) Object.assign(prev, { code: s.code, flag: s.flag, country: s.country });
      }
    }
  });
  const list = [...byKey.values()].sort((a, b) =>
    (b.score - a.score) || ((b.proto === 'socks5') - (a.proto === 'socks5')));
  return { candidates: list.slice(0, max), total: list.length, sourcesOk };
}

// Fills in the country for servers that came without one (one batch request).
export async function addCountries(servers) {
  const missing = servers.filter((s) => !s.code).slice(0, 100);
  if (!missing.length) return;
  try {
    const res = await fetch('http://ip-api.com/batch?fields=query,countryCode', {
      method: 'POST', body: JSON.stringify(missing.map((s) => s.address)), cache: 'no-store',
    });
    const rows = await res.json();
    const byIp = Object.fromEntries(rows.map((r) => [r.query, r.countryCode]));
    for (const s of missing) {
      const code = byIp[s.address];
      if (code) Object.assign(s, { code, flag: flagFromCode(code), country: countryName(code) });
    }
  } catch { /* countries are nice-to-have */ }
}
