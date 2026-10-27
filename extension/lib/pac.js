// Builds the PAC script Chrome uses to decide which requests go through the VPN.

// Always routed through the VPN so the "Check IP" button shows the VPN address.
export const IP_CHECK_HOST = 'ipwho.is';

export function proxyString(server, socksPort) {
  if (!server || server.kind !== 'direct') {
    return `SOCKS5 127.0.0.1:${socksPort}; SOCKS 127.0.0.1:${socksPort}`;
  }
  const hp = `${server.address}:${server.port}`;
  if (server.proto === 'https') return `HTTPS ${hp}`;
  if (server.proto === 'http') return `PROXY ${hp}`;
  return `SOCKS5 ${hp}; SOCKS ${hp}`;
}

export function normalizeSite(input) {
  let s = String(input || '').trim().toLowerCase();
  if (!s) return '';
  s = s.replace(/^[a-z]+:\/\//, '').split(/[/?#]/)[0].replace(/:\d+$/, '');
  s = s.replace(/^\*\./, '').replace(/^www\./, '').replace(/\.$/, '');
  if (!/^[a-z0-9.-]+\.[a-z0-9-]{2,}$/.test(s) && !/^\d+\.\d+\.\d+\.\d+$/.test(s)) return '';
  return s;
}

export function buildPac({ mode, sites, proxy, bypass = [] }) {
  const targeted = mode === 'targeted';
  const list = targeted ? [...new Set([...sites, IP_CHECK_HOST])] : [];
  return `
var PROXY = ${JSON.stringify(proxy)};
var SITES = ${JSON.stringify(list)};
var BYPASS = ${JSON.stringify(bypass)};
function match(host, d) { return host === d || dnsDomainIs(host, "." + d); }
function FindProxyForURL(url, host) {
  host = host.toLowerCase();
  if (isPlainHostName(host) || host === "localhost" ||
      shExpMatch(host, "127.*") || shExpMatch(host, "10.*") || shExpMatch(host, "192.168.*") ||
      shExpMatch(host, "169.254.*") || /^172\\.(1[6-9]|2[0-9]|3[01])\\./.test(host) ||
      host === "[::1]" || /\\.local$/.test(host)) return "DIRECT";
  for (var i = 0; i < BYPASS.length; i++) if (match(host, BYPASS[i])) return "DIRECT";
  ${targeted ? `for (var j = 0; j < SITES.length; j++) if (match(host, SITES[j])) return PROXY;
  return "DIRECT";` : 'return PROXY;'}
}`;
}
