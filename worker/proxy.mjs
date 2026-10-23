import { createServer } from 'node:http';
import { connect } from 'node:net';
import { publicUrl, publicDns } from '../lib/app/network.mjs';

/** Start a loopback-only HTTPS CONNECT proxy that pins public DNS destinations per connection. */
export async function startEgressProxy() {
  const server = createServer(/* Plain HTTP browsing is not part of the connector. */ (_req, res) => { res.writeHead(403); res.end('HTTPS required'); });
  server.on('connect', /* Validate the destination before connecting; never expose an open proxy. */ async (req, client, head) => {
    let upstream;
    client.on('error', /* A closed browser tunnel should also close its destination socket. */ () => upstream?.destroy());
    try {
      const target = publicUrl(`https://${req.url}`);
      if (target.pathname !== '/' || target.search) throw new Error('Invalid tunnel');
      const address = await publicDns(target.hostname);
      if (client.destroyed) return;
      upstream = connect({ host: address.address, family: address.family, port: 443 });
      upstream.setTimeout(120000);
      upstream.on('timeout', /* Bound idle tunnels, including abandoned websocket connections. */ () => upstream.destroy());
      upstream.on('error', /* Return no destination details or credentials to an untrusted page. */ () => client.destroy());
      upstream.on('connect', /* Chromium performs end-to-end TLS inside this byte tunnel. */ () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) upstream.write(head);
        upstream.pipe(client); client.pipe(upstream);
      });
    } catch { client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); }
  });
  await new Promise(/* Resolve only after the loopback socket is ready. */ (resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}
