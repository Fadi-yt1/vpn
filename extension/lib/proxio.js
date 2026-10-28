// Servers from Proxio.io, using the user's own API key.
// The key is kept in this browser only and is sent only to proxio.io.

import { hashId } from './links.js';
import { flagFromCode, countryName } from './freeproxies.js';

const API = 'https://proxio.io/api/list';
const HOST_RE = /^(\d{1,3}(\.\d{1,3}){3}|[a-z0-9.-]+\.[a-z]{2,})$/i;

function normProto(p, fallback) {
  p = String(p || fallback || '').toLowerCase();
  if (p.startsWith('socks5') || p === 'socks') return 'socks5';
  if (p === 'http' || p === 'https') return 'http'; // HTTP proxy (works for HTTPS sites too)
  return null; // socks4 etc. not supported
}

function makeServer({ proto, host, port, username = '', password = '', code = '' }) {
  port = Number(port);
  if (!proto || !HOST_RE.test(String(host || '')) || !(port > 0 && port < 65536)) return null;
  code = /^[A-Z]{2}$/i.test(code || '') ? code.toUpperCase() : '';
  const key = `proxio:${proto}://${username}@${host}:${port}`;
  return {
    id: hashId(key), kind: 'direct', proto, address: host, port, username, password,
    code, flag: flagFromCode(code), country: countryName(code),
    name: `${proto.toUpperCase()} ${host}:${port}`, link: `${proto}://${host}:${port}`,
    sourceId: 'proxio', source: 'Proxio.io', supported: true, proxio: true,
  };
}

// One line or string: proto://user:pass@host:port, user:pass@host:port,
// host:port:user:pass or host:port.
export function parseProxyLine(line, defaultProto) {
  let s = String(line || '').trim();
  if (!s || s.startsWith('#')) return null;
  let proto = defaultProto;
  const m = s.match(/^([a-z0-9]+):\/\//i);
  if (m) { proto = m[1]; s = s.slice(m[0].length); }
  let username = '', password = '';
  const at = s.lastIndexOf('@');
  if (at >= 0) {
    [username, ...password] = s.slice(0, at).split(':');
    password = password.join(':');
    s = s.slice(at + 1);
  }
  const parts = s.split(/[\s,;]+/)[0].split(':');
  const [host, port] = parts;
  if (at < 0 && parts.length >= 4) { username = parts[2]; password = parts.slice(3).join(":"); }
  return makeServer({ proto: normProto(proto), host, port, username: decodeSafe(username), password: decodeSafe(password) });
}

function decodeSafe(v) { try { return decodeURIComponent(v); } catch { return v; } }

const pick = (o, ...keys) => { for (const k of keys) if (o?.[k] != null && o[k] !== '') return o[k]; return undefined; };

// Reads whatever shape the API returns: JSON objects, JSON strings, or plain text.
export function parseProxioResponse(text, defaultProto) {
  const out = [];
  let data;
  try { data = JSON.parse(text); } catch { data = null; }
  if (data == null) {
    for (const line of String(text).split(/\r?\n/)) {
      const s = parseProxyLine(line, defaultProto);
      if (s) out.push(s);
    }
    return out;
  }
  const walk = (v, depth) => {
    if (depth > 5 || v == null) return;
    if (typeof v === 'string') { const s = parseProxyLine(v, defaultProto); if (s) out.push(s); return; }
    if (Array.isArray(v)) { for (const x of v) walk(x, depth + 1); return; }
    if (typeof v !== 'object') return;
    const host = pick(v, 'ip', 'host', 'address', 'server', 'hostname');
    const port = pick(v, 'port');
    if (host && port) {
      const geo = v.geolocation || v.geo || v.location || v.ip_data || {};
      let code = pick(v, 'country_code', 'countryCode', 'cc') || pick(geo, 'country_code', 'countryCode', 'country') || v.country;
      if (typeof code !== 'string') code = '';
      let protos = pick(v, 'protocols', 'protocol', 'type', 'scheme');
      protos = Array.isArray(protos) ? protos : [protos];
      for (const p of protos) {
        const s = makeServer({
          proto: normProto(p, defaultProto), host: String(host), port,
          username: String(pick(v, 'username', 'user', 'login') || ''),
          password: String(pick(v, 'password', 'pass') || ''),
          code,
        });
        if (s) out.push(s);
      }
      return;
    }
    if (typeof v.proxy === 'string') { const s = parseProxyLine(v.proxy, defaultProto); if (s) out.push(s); return; }
    for (const x of Object.values(v)) walk(x, depth + 1);
  };
  walk(data, 0);
  return out;
}

// Downloads the list for each requested type. Throws a readable error on failure.
export async function fetchProxio({ key, type = 'socks5', limit = 50 }) {
  if (!key) throw new Error('Enter your Proxio.io API key first.');
  const types = type === 'both' ? ['socks5', 'http'] : [type];
  const all = new Map();
  for (const t of types) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 20000);
    let res;
    try {
      res = await fetch(`${API}?type=${encodeURIComponent(t)}&limit=${Number(limit) || 50}`, {
        headers: { 'X-Key': key, Accept: 'application/json, text/plain, */*' },
        cache: 'no-store', credentials: 'omit', signal: ctl.signal,
      });
    } catch (e) {
      throw new Error(ctl.signal.aborted ? 'Proxio.io did not answer in time. Try again.' : 'Could not reach proxio.io. Check your internet connection.');
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text();
    if (res.status === 401 || res.status === 403) throw new Error('Proxio.io rejected the API key. Check that it is correct and active.');
    if (res.status === 429) throw new Error('Proxio.io says too many requests. Wait a minute and try again.');
    if (!res.ok) throw new Error(`Proxio.io error (${res.status}): ${text.slice(0, 120)}`);
    for (const s of parseProxioResponse(text, t)) all.set(s.id, s);
  }
  return [...all.values()];
}
