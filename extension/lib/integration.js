// "My proxies": reads proxies out of whatever the user pastes — a curl command,
// Python or Node.js code, proxy URLs, or provider lists (ip:port:user:pass) —
// and writes integration snippets (curl / Python / Node.js) for a proxy.

import { hashId } from './links.js';
import { flagFromCode, countryName } from './freeproxies.js';

const HOST = '(\\d{1,3}(?:\\.\\d{1,3}){3}|[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\\.[a-z0-9-]+)+)';

function decodeSafe(v) { try { return decodeURIComponent(v); } catch { return v; } }

function normProto(p) {
  p = String(p || 'http').toLowerCase();
  if (p.startsWith('socks5')) return 'socks5';
  if (p === 'http' || p === 'https') return 'http'; // http:// proxies also carry HTTPS sites
  return null; // socks4 and others: not usable in Chrome
}

export function makeCustomServer({ proto, host, port, username = '', password = '' }) {
  const p = normProto(proto);
  port = Number(port);
  if (!p || !host || !(port > 0 && port < 65536)) return null;
  const key = `custom:${p}://${username}@${host}:${port}`;
  return {
    id: hashId(key), kind: 'direct', proto: p, address: String(host).toLowerCase(), port,
    username: decodeSafe(username), password: decodeSafe(password),
    code: '', flag: '🌐', country: 'Unknown',
    name: `${p.toUpperCase()} ${host}:${port}`, link: `${p}://${host}:${port}`,
    sourceId: 'custom', source: 'My proxies', supported: true, custom: true,
  };
}

// Finds every proxy in the pasted text. Returns { servers, skipped } where
// skipped counts entries Chrome can't use (e.g. SOCKS4).
export function extractProxies(input) {
  const text = String(input || '');
  const found = [];
  let skipped = 0;
  const add = (o) => { const s = makeCustomServer(o); if (s) found.push(s); else skipped++; };

  // 1) curl: only the --proxy / -x value counts (the other URL is the target site).
  const curlUser = text.match(/(?:--proxy-user|-U)\s+["']?([^\s"']+)["']?/);
  const curlProxy = [...text.matchAll(/(?:--proxy|(?:^|\s)-x)\s*[= ]\s*["']?([^\s"']+)["']?/g)].map((m) => m[1]);
  let rest = text;
  for (const raw of curlProxy) {
    rest = rest.replace(raw, ' ');
    const withScheme = /^[a-z0-9]+:\/\//i.test(raw) ? raw : `http://${raw}`;
    const m = withScheme.match(new RegExp(`^([a-z0-9]+)://(?:([^:@/\\s]*)(?::([^@/\\s]*))?@)?${HOST}:(\\d{1,5})`, 'i'));
    if (!m) { skipped++; continue; }
    let [, proto, user = '', pass = '', host, port] = m;
    if (!user && curlUser) [user, pass = ''] = curlUser[1].split(/:(.*)/s);
    add({ proto, host, port, username: user, password: pass });
  }
  if (curlProxy.length) rest = rest.replace(/\bcurl\b[^\n]*/g, (line) => line.replace(/https?:\/\/[^\s"']+/g, ' '));

  // 2) Proxy URLs anywhere (Python proxies dict, Node.js agents, plain lists).
  const urlRe = new RegExp(`\\b([a-z][a-z0-9]*)://(?:([^:@/\\s"'\`]*)(?::([^@/\\s"'\`]*))?@)?${HOST}:(\\d{1,5})`, 'gi');
  for (const m of rest.matchAll(urlRe)) {
    const scheme = m[1].toLowerCase();
    if (!/^(https?|socks[45][ah]?)$/.test(scheme)) continue;
    add({ proto: scheme, host: m[4], port: m[5], username: m[2] || '', password: m[3] || '' });
  }

  // 3) Node.js axios style: proxy: { protocol, host, port, auth: { username, password } }
  for (const block of text.matchAll(/proxy\s*:\s*\{([\s\S]*?\})\s*\}?/g)) {
    const b = block[1];
    const host = b.match(/host\s*:\s*['"`]([^'"`]+)['"`]/)?.[1];
    const port = b.match(/port\s*:\s*['"`]?(\d{1,5})/)?.[1];
    if (!host || !port) continue;
    add({
      proto: b.match(/protocol\s*:\s*['"`]([a-z0-9]+)/i)?.[1] || 'http', host, port,
      username: b.match(/username\s*:\s*['"`]([^'"`]*)['"`]/)?.[1] || '',
      password: b.match(/password\s*:\s*['"`]([^'"`]*)['"`]/)?.[1] || '',
    });
  }

  // 4) Provider lists: ip:port:user:pass, user:pass@ip:port, ip:port (one per line).
  const lineRe = new RegExp(`^\\s*(?:([^:@\\s]+):([^@\\s]+)@)?${HOST}:(\\d{1,5})(?::([^:\\s]+):(\\S+))?\\s*$`, 'i');
  for (const line of rest.split(/\r?\n/)) {
    const m = line.match(lineRe);
    if (!m) continue;
    add({ proto: 'http', host: m[3], port: m[4], username: m[1] || m[5] || '', password: m[2] || m[6] || '' });
  }

  const unique = [...new Map(found.map((s) => [s.id, s])).values()];
  return { servers: unique, skipped };
}

export function withCountry(s, code) {
  if (!code) return s;
  return { ...s, code, flag: flagFromCode(code), country: countryName(code) };
}

// ---------- integration snippets ----------
function proxyUrl(s, { hide = false } = {}) {
  const scheme = s.proto === 'socks5' ? 'socks5h' : 'http';
  const auth = s.username ? `${encodeURIComponent(s.username)}:${hide ? '••••••' : encodeURIComponent(s.password)}@` : '';
  return `${scheme}://${auth}${s.address}:${s.port}`;
}

export function integrationCode(s, lang, { hide = false, target = 'https://ipv4.webshare.io/' } = {}) {
  const url = proxyUrl(s, { hide });
  if (lang === 'curl') return `curl --proxy "${url}/" ${target}`;
  if (lang === 'python') {
    return [
      s.proto === 'socks5' ? '# pip install "requests[socks]"' : '# pip install requests',
      'import requests',
      '',
      `proxy = "${url}/"`,
      'proxies = {"http": proxy, "https": proxy}',
      '',
      `response = requests.get("${target}", proxies=proxies, timeout=30)`,
      'print(response.text)',
    ].join('\n');
  }
  if (s.proto === 'socks5') {
    return [
      '// npm install axios socks-proxy-agent',
      "const axios = require('axios');",
      "const { SocksProxyAgent } = require('socks-proxy-agent');",
      '',
      `const agent = new SocksProxyAgent('${url}');`,
      `axios.get('${target}', { httpAgent: agent, httpsAgent: agent, proxy: false })`,
      '  .then((res) => console.log(res.data))',
      '  .catch((err) => console.error(err.message));',
    ].join('\n');
  }
  return [
    '// npm install axios https-proxy-agent',
    "const axios = require('axios');",
    "const { HttpsProxyAgent } = require('https-proxy-agent');",
    '',
    `const agent = new HttpsProxyAgent('${url}');`,
    `axios.get('${target}', { httpsAgent: agent, proxy: false })`,
    '  .then((res) => console.log(res.data))',
    '  .catch((err) => console.error(err.message));',
  ].join('\n');
}
