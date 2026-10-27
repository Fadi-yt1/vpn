// Parses share links and subscription files into plain server objects.
// Supported: vless://, vmess://, trojan://, ss://, socks(5)://, http(s)://

const FLAG_RE = /([\u{1F1E6}-\u{1F1FF}]{2})/u;

export function b64decode(str) {
  let s = str.trim().replace(/-/g, '+').replace(/_/g, '/').replace(/\s+/g, '');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function safeDecode(s) {
  try { return decodeURIComponent(s); } catch { return s; }
}

export function hashId(str) {
  // FNV-1a, 32-bit, good enough for ids
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

function countryFromName(name) {
  const m = name.match(FLAG_RE);
  if (!m) return { flag: '🌐', country: 'Unknown' };
  const flag = m[1];
  // Text right after the flag is usually the country name.
  const after = name.slice(name.indexOf(flag) + flag.length).split(/[┃|,]/)[0].trim();
  // Turn the flag into an ISO code (🇩🇪 -> DE) as a fallback label.
  const code = [...flag].map((c) => String.fromCharCode(c.codePointAt(0) - 0x1f1e6 + 65)).join('');
  return { flag, country: after || code, code };
}

function splitHostPort(hp) {
  // handles host:port and [ipv6]:port
  const m = hp.match(/^\[([^\]]+)\]:(\d+)$/) || hp.match(/^([^:]+):(\d+)$/);
  if (!m) throw new Error('bad host:port ' + hp);
  return { address: m[1], port: Number(m[2]) };
}

// Splits scheme://userinfo@host:port?query#name without relying on URL()
// quirks for custom schemes.
function splitLink(link) {
  const scheme = link.slice(0, link.indexOf('://')).toLowerCase();
  let rest = link.slice(scheme.length + 3);
  let name = '';
  const hashAt = rest.indexOf('#');
  if (hashAt >= 0) { name = safeDecode(rest.slice(hashAt + 1)); rest = rest.slice(0, hashAt); }
  let query = '';
  const qAt = rest.indexOf('?');
  if (qAt >= 0) { query = rest.slice(qAt + 1); rest = rest.slice(0, qAt); }
  rest = rest.replace(/\/$/, '');
  let user = '';
  const at = rest.lastIndexOf('@');
  if (at >= 0) { user = rest.slice(0, at); rest = rest.slice(at + 1); }
  const params = {};
  for (const [k, v] of new URLSearchParams(query)) params[k] = v;
  return { scheme, user, hostport: rest, params, name };
}

function streamFromParams(p) {
  const s = {
    net: (p.type || 'tcp').toLowerCase(),
    security: (p.security || 'none').toLowerCase(),
    sni: p.sni || p.peer || '',
    fp: p.fp || '',
    alpn: p.alpn ? p.alpn.split(',').map((a) => a.trim()).filter(Boolean) : [],
    pbk: p.pbk || '',
    sid: p.sid || '',
    spx: p.spx || '',
    host: p.host || '',
    path: p.path || '',
    serviceName: p.serviceName || p.servicename || '',
    mode: p.mode || '',
    headerType: p.headerType || '',
    allowInsecure: p.allowInsecure === '1' || p.insecure === '1' || p.allowInsecure === 'true',
    flow: p.flow || '',
  };
  if (p.extra && p.extra !== 'null') {
    try { s.extra = JSON.parse(p.extra); } catch { /* ignore broken extra */ }
  }
  return s;
}

function finish(server, link) {
  const meta = countryFromName(server.name || '');
  const out = { ...server, ...meta, link, id: hashId(link) };
  if (!out.name) out.name = `${out.address}:${out.port}`;
  out.supported = isSupported(out);
  return out;
}

const SUPPORTED_NETS = new Set(['tcp', 'raw', 'ws', 'grpc', 'xhttp', 'splithttp', 'httpupgrade']);

function isSupported(s) {
  if (s.kind === 'direct') return true;
  if (!SUPPORTED_NETS.has(s.net)) return false;
  if (s.security === 'reality' && !s.pbk) return false;
  return true;
}

export function parseLink(line) {
  const link = line.trim();
  const scheme = link.slice(0, link.indexOf('://')).toLowerCase();

  if (scheme === 'vmess') {
    const j = JSON.parse(b64decode(link.slice(8).split('#')[0]));
    return finish({
      kind: 'core', proto: 'vmess',
      address: j.add, port: Number(j.port), uuid: j.id, aid: Number(j.aid || 0),
      cipher: j.scy || 'auto', name: j.ps || '',
      net: (j.net || 'tcp').toLowerCase(),
      security: j.tls === 'tls' ? 'tls' : j.tls === 'reality' ? 'reality' : 'none',
      sni: j.sni || '', fp: j.fp || '', alpn: j.alpn ? String(j.alpn).split(',') : [],
      host: j.host || '', path: j.path || '', serviceName: j.net === 'grpc' ? (j.path || '') : '',
      mode: j.type === 'multi' ? 'multi' : '', headerType: j.type === 'http' ? 'http' : '',
      pbk: j.pbk || '', sid: j.sid || '', spx: j.spx || '', allowInsecure: false, flow: '',
    }, link);
  }

  const { user, hostport, params, name } = splitLink(link);

  if (scheme === 'vless' || scheme === 'trojan') {
    const { address, port } = splitHostPort(hostport);
    const stream = streamFromParams(params);
    if (scheme === 'trojan' && !params.security) stream.security = 'tls';
    return finish({
      kind: 'core', proto: scheme, address, port, name,
      uuid: scheme === 'vless' ? safeDecode(user) : undefined,
      password: scheme === 'trojan' ? safeDecode(user) : undefined,
      ...stream,
    }, link);
  }

  if (scheme === 'ss') {
    if (params.plugin) throw new Error('ss plugins are not supported');
    let method, password, address, port;
    if (user) {
      let info = safeDecode(user);
      if (!info.includes(':')) info = b64decode(info);
      [method, ...password] = info.split(':');
      password = password.join(':');
      ({ address, port } = splitHostPort(hostport));
    } else {
      // legacy: ss://base64(method:password@host:port)
      const dec = b64decode(hostport);
      const at = dec.lastIndexOf('@');
      [method, ...password] = dec.slice(0, at).split(':');
      password = password.join(':');
      ({ address, port } = splitHostPort(dec.slice(at + 1)));
    }
    return finish({ kind: 'core', proto: 'shadowsocks', address, port, method, password, name, net: 'tcp', security: 'none' }, link);
  }

  if (['socks', 'socks5', 'http', 'https'].includes(scheme)) {
    const { address, port } = splitHostPort(hostport);
    let username = '', password = '';
    if (user) {
      let info = safeDecode(user);
      if (!info.includes(':')) { try { info = b64decode(info); } catch { /* plain user */ } }
      [username, ...password] = info.split(':');
      password = password.join(':');
    }
    return finish({
      kind: 'direct', proto: scheme === 'socks' ? 'socks5' : scheme,
      address, port, username, password, name,
    }, link);
  }

  return null;
}

export function parseSubscription(input) {
  let text = (input || '').trim();
  if (text && !text.includes('://')) {
    try { text = b64decode(text); } catch { /* not base64 */ }
  }
  const meta = {};
  const servers = [];
  const seen = new Set();
  let skipped = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#')) {
      const m = line.match(/^#([\w-]+):\s*(.*)$/);
      if (m) meta[m[1]] = m[2];
      continue;
    }
    if (!line.includes('://')) continue;
    try {
      const s = parseLink(line);
      if (!s || seen.has(s.id)) continue;
      seen.add(s.id);
      if (!s.supported) { skipped++; continue; }
      servers.push(s);
    } catch {
      skipped++;
    }
  }
  return { meta, servers, skipped };
}
