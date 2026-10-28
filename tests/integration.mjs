// node tests/integration.mjs — reading proxies from curl / Python / Node.js / lists.
import assert from 'node:assert';
import { extractProxies, integrationCode } from '../extension/lib/integration.js';

const links = (t) => extractProxies(t).servers.map((s) => `${s.proto}://${s.username ? s.username + ':' + s.password + '@' : ''}${s.address}:${s.port}`);

// curl (the target URL must not be taken as a proxy)
assert.deepEqual(links('curl --proxy "http://user1:pa55@10.20.30.40:6014/" https://ipv4.webshare.io/'), ['http://user1:pa55@10.20.30.40:6014']);
assert.deepEqual(links('curl -x 10.20.30.40:8080 -U bob:secret https://example.com:8443/x'), ['http://bob:secret@10.20.30.40:8080']);
assert.deepEqual(links('curl --proxy socks5h://u:p@proxy.example.net:1080 https://api.ipify.org'), ['socks5://u:p@proxy.example.net:1080']);
// Python requests
assert.deepEqual(links(`import requests
proxies = {"http": "http://user1:pa55@10.20.30.40:6014/", "https": "http://user1:pa55@10.20.30.40:6014/"}
requests.get("https://ipv4.webshare.io/", proxies=proxies)`), ['http://user1:pa55@10.20.30.40:6014']);
// Node.js agent + axios object
assert.deepEqual(links("const agent = new HttpsProxyAgent('http://a:b@1.2.3.4:3128');"), ['http://a:b@1.2.3.4:3128']);
assert.deepEqual(links(`axios.get('https://ipv4.webshare.io/', { proxy: { protocol: 'http', host: '5.6.7.8', port: 6014, auth: { username: 'x1', password: 'y2' } } })`), ['http://x1:y2@5.6.7.8:6014']);
// Webshare download list + plain lines
assert.deepEqual(links('9.9.9.9:6014:alice:pw1\n8.8.8.8:6015:bob:pw2\n7.7.7.7:3128'), ['http://alice:pw1@9.9.9.9:6014', 'http://bob:pw2@8.8.8.8:6015', 'http://7.7.7.7:3128']);
// unusable / junk
assert.equal(extractProxies('socks4://1.1.1.1:1080').servers.length, 0);
assert.equal(extractProxies('hello world https://example.com/').servers.length, 0);

// snippets
const s = extractProxies('http://user1:pa55@10.20.30.40:6014').servers[0];
assert.equal(integrationCode(s, 'curl'), 'curl --proxy "http://user1:pa55@10.20.30.40:6014/" https://ipv4.webshare.io/');
assert.match(integrationCode(s, 'python', { hide: true }), /http:\/\/user1:••••••@10\.20\.30\.40:6014/);
assert.match(integrationCode(s, 'node'), /HttpsProxyAgent\('http:\/\/user1:pa55@10\.20\.30\.40:6014'\)/);
// round trip: the snippets we generate can be pasted back in
for (const lang of ['curl', 'python', 'node']) assert.deepEqual(links(integrationCode(s, lang)), ['http://user1:pa55@10.20.30.40:6014'], lang);
console.log('proxy integration parser: all checks passed');
