import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import tls from 'node:tls';
import { defineConfig, type HttpServer, type Plugin } from 'vite';

/**
 * Vite plugin that tunnels WebSocket upgrades on `/bbs` to `wss://ws.ptt.cc/bbs`
 * with `Origin: https://term.ptt.cc` and `ALPNProtocols: ['http/1.1']` so that
 * PTT's openresty gateway accepts browser connections from localhost.
 */
function pttWebSocketProxyPlugin(): Plugin {
  const attachUpgradeHandler = (httpServer: HttpServer | null) => {
    if (!httpServer) return;

    httpServer.on(
      'upgrade',
      (req: IncomingMessage, clientSocket: Duplex, head: Buffer) => {
        const urlPath = (req.url || '/').split('?')[0];
        if (urlPath !== '/bbs') return;

        const wsKey = req.headers['sec-websocket-key'];
        const wsVersion = req.headers['sec-websocket-version'] || '13';
        const wsProto = req.headers['sec-websocket-protocol'] || 'telnet';

        const upstream = tls.connect(
          {
            host: 'ws.ptt.cc',
            port: 443,
            servername: 'ws.ptt.cc',
            ALPNProtocols: ['http/1.1'],
          },
          () => {
            const handshake = [
              'GET /bbs HTTP/1.1',
              'Host: ws.ptt.cc',
              'Upgrade: websocket',
              'Connection: Upgrade',
              'Origin: https://term.ptt.cc',
              'User-Agent: Mozilla/5.0 (X11; Linux x86_64) GhosPTT/1.0',
              `Sec-WebSocket-Key: ${wsKey}`,
              `Sec-WebSocket-Version: ${wsVersion}`,
              `Sec-WebSocket-Protocol: ${wsProto}`,
              '',
              '',
            ].join('\r\n');

            upstream.write(handshake);
            if (head && head.length > 0) {
              upstream.write(head);
            }
          }
        );

        upstream.pipe(clientSocket);
        clientSocket.pipe(upstream);

        upstream.on('error', () => clientSocket.destroy());
        clientSocket.on('error', () => upstream.destroy());
        clientSocket.on('close', () => upstream.destroy());
        upstream.on('close', () => clientSocket.destroy());
      }
    );
  };

  return {
    name: 'ptt-websocket-proxy',
    configureServer(server) {
      attachUpgradeHandler(server.httpServer);
    },
    configurePreviewServer(server) {
      attachUpgradeHandler(server.httpServer);
    },
  };
}

export default defineConfig({
  plugins: [pttWebSocketProxyPlugin()],
  server: {
    port: 8000,
    strictPort: false,
  },
  preview: {
    port: 8000,
  },
});
