// node tests/freeproxies.mjs — checks the free-list parser on sample formats.
import assert from 'node:assert';
import { fromJson, fromText } from '../extension/lib/freeproxies.js';

// proxifly-like
const a = fromJson([{ proxy: 'socks5://1.2.3.4:1080', protocol: 'socks5', ip: '1.2.3.4', port: 1080, geolocation: { country: 'DE' } },
  { proxy: 'socks4://5.6.7.8:4145', protocol: 'socks4', ip: '5.6.7.8', port: 4145 }], 'x');
assert.equal(a.length, 1); assert.equal(a[0].proto, 'socks5'); assert.equal(a[0].code, 'DE'); assert.equal(a[0].country, 'Germany');
// proxyscrape-like
const b = fromJson({ proxies: [{ protocol: 'http', ip: '9.9.9.9', port: 8080, ip_data: { countryCode: 'US' } }] }, 'x');
assert.equal(b[0].proto, 'http'); assert.equal(b[0].country, 'United States');
// geonode-like
const c = fromJson({ data: [{ ip: '8.8.4.4', port: '3128', protocols: ['http', 'socks5'], country: 'NL' }], total: 1 }, 'x');
assert.deepEqual(c.map((s) => s.proto).sort(), ['http', 'socks5']); assert.equal(c[0].flag, '🇳🇱');
// text lists
const d = fromText('1.1.1.1:80\nsocks5://2.2.2.2:1080\ngarbage\nhttp://3.3.3.3:3128\nsocks4://4.4.4.4:1\n', 'x', 'http');
assert.deepEqual(d.map((s) => s.link), ['http://1.1.1.1:80', 'socks5://2.2.2.2:1080', 'http://3.3.3.3:3128']);
console.log('free list parser: all checks passed');
