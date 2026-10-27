// Quick self-check: node tests/check.mjs <subscription-file>
import { readFileSync } from 'node:fs';
import { parseSubscription } from '../extension/lib/links.js';
import { buildConfig } from '../extension/lib/xray.js';
import { buildPac } from '../extension/lib/pac.js';

const text = readFileSync(process.argv[2], 'utf8');
const { meta, servers, skipped } = parseSubscription(text);
console.log('title:', meta['profile-title'], '| servers:', servers.length, '| skipped:', skipped);
const by = (k) => servers.reduce((m, s) => ((m[s[k]] = (m[s[k]] || 0) + 1), m), {});
console.log('proto', by('proto'), '\nnet', by('net'), '\nsecurity', by('security'));
console.log('countries', Object.keys(by('country')).length, servers.slice(0, 2).map((s) => `${s.flag} ${s.country} ${s.sni}`));
for (const s of servers) {
  if (!s.address || !s.port || (s.proto === 'vless' && !s.uuid) || (s.proto === 'trojan' && !s.password)) throw new Error('bad ' + s.link);
}
const cfg = buildConfig(servers.slice(0, 8), {});
console.log(JSON.stringify(cfg.outbounds[0], null, 1).slice(0, 1500));
console.log('balancer:', JSON.stringify(cfg.routing.balancers));
const pacSrc = buildPac({ mode: 'targeted', sites: ['youtube.com'], proxy: 'SOCKS5 127.0.0.1:10808' });
const FindProxyForURL = new Function('isPlainHostName', 'dnsDomainIs', 'shExpMatch',
  pacSrc + '; return FindProxyForURL;')(
  (h) => !h.includes('.'), (h, d) => h.endsWith(d),
  (h, p) => new RegExp('^' + p.replace(/\./g, '\\.').replace(/\*/g, '.*') + '$').test(h));
for (const h of ['youtube.com', 'm.youtube.com', 'notyoutube.com', 'google.com', '192.168.1.1', 'ipwho.is'])
  console.log(h.padEnd(16), FindProxyForURL('https://' + h + '/', h));
