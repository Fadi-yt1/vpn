// Builds the PAC script Chrome uses to decide which requests go through the VPN.

// Always routed through the VPN so the "Check IP" button shows the VPN address.
export const IP_CHECK_HOST = 'ipwho.is';

function oneProxy(server, socksPort) {
  if (!server || server.kind !== 'direct') {
    return `SOCKS5 127.0.0.1:${socksPort}; SOCKS 127.0.0.1:${socksPort}`;
  }
  const hp = `${server.address}:${server.port}`;
  if (server.proto === 'https') return `HTTPS ${hp}`;
  if (server.proto === 'http') return `PROXY ${hp}`;
  return `SOCKS5 ${hp}`;
}

// A list of servers becomes a failover chain: Chrome tries the next one if one fails.
export function proxyString(server, socksPort) {
  if (Array.isArray(server)) return server.map((s) => oneProxy(s, socksPort)).join('; ');
  return oneProxy(server, socksPort);
}

export function normalizeSite(input) {
  let s = String(input || '').trim().toLowerCase();
  if (!s) return '';
  s = s.replace(/^[a-z]+:\/\//, '').split(/[/?#]/)[0].replace(/:\d+$/, '');
  s = s.replace(/^\*\./, '').replace(/^www\./, '').replace(/\.$/, '');
  if (!/^[a-z0-9.-]+\.[a-z0-9-]{2,}$/.test(s) && !/^\d+\.\d+\.\d+\.\d+$/.test(s)) return '';
  return s;
}

// tests: used while speed-testing free servers.
//   byTag:  { tag: proxy }  -> http URLs with ?ogt=<tag> go through that proxy
//   byHost: { host: proxy } -> requests to that host go through that proxy
export function buildPac({ mode, sites, proxy, bypass = [], tests = null, enabled = true }) {
  const targeted = mode === 'targeted';
  const list = targeted ? [...new Set([...sites, IP_CHECK_HOST])] : [];
  return `
var PROXY = ${JSON.stringify(proxy)};
var SITES = ${JSON.stringify(list)};
var BYPASS = ${JSON.stringify(bypass)};
var TEST_TAG = ${JSON.stringify(tests?.byTag || {})};
var TEST_HOST = ${JSON.stringify(tests?.byHost || {})};
var ENABLED = ${JSON.stringify(enabled)};
function match(host, d) { return host === d || dnsDomainIs(host, "." + d); }
function FindProxyForURL(url, host) {
  host = host.toLowerCase();
  var t = url.match(/[?&]ogt=([a-z0-9_]+)/);
  if (t && TEST_TAG[t[1]]) return TEST_TAG[t[1]];
  if (TEST_HOST[host]) return TEST_HOST[host];
  if (!ENABLED) return "DIRECT";
  if (isPlainHostName(host) || host === "localhost" ||
      shExpMatch(host, "127.*") || shExpMatch(host, "10.*") || shExpMatch(host, "192.168.*") ||
      shExpMatch(host, "169.254.*") || /^172\\.(1[6-9]|2[0-9]|3[01])\\./.test(host) ||
      host === "[::1]" || /\\.local$/.test(host)) return "DIRECT";
  for (var i = 0; i < BYPASS.length; i++) if (match(host, BYPASS[i])) return "DIRECT";
  ${targeted ? `for (var j = 0; j < SITES.length; j++) if (match(host, SITES[j])) return PROXY;
  return "DIRECT";` : 'return PROXY;'}
}`;
}
