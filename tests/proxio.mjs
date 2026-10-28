// node tests/proxio.mjs — checks the Proxio.io response reader on likely formats.
import assert from 'node:assert';
import { parseProxioResponse, parseProxyLine } from '../extension/lib/proxio.js';

const links = (list) => list.map((s) => `${s.proto}://${s.username ? s.username + ':' + s.password + '@' : ''}${s.address}:${s.port}`);
// plain text
assert.deepEqual(links(parseProxioResponse('1.2.3.4:1080\n5.6.7.8:1081\n', 'socks5')), ['socks5://1.2.3.4:1080', 'socks5://5.6.7.8:1081']);
// JSON array of strings with logins
assert.deepEqual(links(parseProxioResponse('["http://u:p@9.9.9.9:8080","socks5://2.2.2.2:1080"]', 'socks5')), ['http://u:p@9.9.9.9:8080', 'socks5://2.2.2.2:1080']);
// JSON objects wrapped in data
const objs = parseProxioResponse(JSON.stringify({ success: true, data: [{ ip: '3.3.3.3', port: 1080, type: 'socks5', country_code: 'US' }, { host: 'gw.example.net', port: '9000', protocol: 'http', username: 'a', password: 'b', country: 'DE' }] }), 'socks5');
assert.deepEqual(links(objs), ['socks5://3.3.3.3:1080', 'http://a:b@gw.example.net:9000']);
assert.equal(objs[0].country, 'United States'); assert.equal(objs[1].code, 'DE');
// ip:port:user:pass
assert.deepEqual(links([parseProxyLine('4.4.4.4:3128:joe:se:cret', 'http')]), ['http://joe:se:cret@4.4.4.4:3128']);
// junk / error bodies give nothing
assert.equal(parseProxioResponse('{"error":"invalid key"}', 'socks5').length, 0);
assert.equal(parseProxioResponse('<html>oops</html>', 'socks5').length, 0);
console.log('proxio parser: all checks passed');
