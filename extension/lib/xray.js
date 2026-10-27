// Turns parsed servers into an Xray-core config.

function clean(obj) {
  if (Array.isArray(obj)) return obj.map(clean);
  if (obj && typeof obj === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      if (v === undefined || v === null || v === '') continue;
      if (Array.isArray(v) && v.length === 0) continue;
      out[k] = clean(v);
    }
    return out;
  }
  return obj;
}

function streamSettings(s) {
  let net = s.net || 'tcp';
  if (net === 'tcp') net = 'raw';
  if (net === 'splithttp') net = 'xhttp';
  const st = { network: net, security: s.security || 'none' };

  if (st.security === 'tls') {
    st.tlsSettings = {
      serverName: s.sni || s.host || undefined,
      fingerprint: s.fp || 'chrome',
      alpn: s.alpn,
      allowInsecure: s.allowInsecure || undefined,
    };
  } else if (st.security === 'reality') {
    st.realitySettings = {
      serverName: s.sni,
      fingerprint: s.fp || 'chrome',
      publicKey: s.pbk,
      shortId: s.sid,
      spiderX: s.spx,
    };
  }

  switch (net) {
    case 'ws':
      st.wsSettings = { path: s.path || '/', host: s.host };
      break;
    case 'grpc':
      st.grpcSettings = { serviceName: s.serviceName, multiMode: s.mode === 'multi' };
      break;
    case 'xhttp':
      st.xhttpSettings = { host: s.host, path: s.path || '/', mode: s.mode || 'auto', extra: s.extra };
      break;
    case 'httpupgrade':
      st.httpupgradeSettings = { path: s.path || '/', host: s.host };
      break;
    case 'raw':
      if (s.headerType === 'http') {
        st.rawSettings = {
          header: {
            type: 'http',
            request: { path: [s.path || '/'], headers: s.host ? { Host: s.host.split(',') } : {} },
          },
        };
      }
      break;
  }
  return st;
}

export function toOutbound(s, tag) {
  let ob;
  if (s.proto === 'vless') {
    ob = {
      protocol: 'vless',
      settings: { vnext: [{ address: s.address, port: s.port, users: [{ id: s.uuid, encryption: 'none', flow: s.flow }] }] },
    };
  } else if (s.proto === 'vmess') {
    ob = {
      protocol: 'vmess',
      settings: { vnext: [{ address: s.address, port: s.port, users: [{ id: s.uuid, alterId: s.aid || 0, security: s.cipher || 'auto' }] }] },
    };
  } else if (s.proto === 'trojan') {
    ob = { protocol: 'trojan', settings: { servers: [{ address: s.address, port: s.port, password: s.password }] } };
  } else if (s.proto === 'shadowsocks') {
    ob = { protocol: 'shadowsocks', settings: { servers: [{ address: s.address, port: s.port, method: s.method, password: s.password }] } };
  } else {
    throw new Error('Unsupported protocol ' + s.proto);
  }
  if (s.proto !== 'shadowsocks') ob.streamSettings = streamSettings(s);
  ob.tag = tag;
  return clean(ob);
}

const PRIVATE_IPS = [
  '0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16',
  '172.16.0.0/12', '192.168.0.0/16', '::1/128', 'fc00::/7', 'fe80::/10',
];

// servers: one server = fixed, several = auto-pick the fastest that works.
export function buildConfig(servers, { socksPort = 10808, httpPort = 10809 } = {}) {
  const outbounds = servers.map((s, i) => toOutbound(s, `proxy-${i}`));
  const auto = outbounds.length > 1;
  const cfg = {
    log: { loglevel: 'warning' },
    inbounds: [
      {
        tag: 'socks-in', listen: '127.0.0.1', port: socksPort, protocol: 'socks',
        settings: { udp: true }, sniffing: { enabled: true, destOverride: ['http', 'tls', 'quic'], routeOnly: true },
      },
      {
        tag: 'http-in', listen: '127.0.0.1', port: httpPort, protocol: 'http',
        sniffing: { enabled: true, destOverride: ['http', 'tls'], routeOnly: true },
      },
    ],
    outbounds: [...outbounds, { tag: 'direct', protocol: 'freedom' }, { tag: 'block', protocol: 'blackhole' }],
    routing: {
      domainStrategy: 'AsIs',
      rules: [
        { type: 'field', ip: PRIVATE_IPS, outboundTag: 'direct' },
        auto
          ? { type: 'field', inboundTag: ['socks-in', 'http-in'], balancerTag: 'fastest' }
          : { type: 'field', inboundTag: ['socks-in', 'http-in'], outboundTag: 'proxy-0' },
      ],
    },
  };
  if (auto) {
    cfg.routing.balancers = [{ tag: 'fastest', selector: ['proxy-'], strategy: { type: 'leastPing' }, fallbackTag: 'proxy-0' }];
    cfg.observatory = {
      subjectSelector: ['proxy-'],
      probeUrl: 'https://www.gstatic.com/generate_204',
      probeInterval: '2m',
      enableConcurrency: true,
    };
  }
  return cfg;
}
