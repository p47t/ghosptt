interface Env {
  ASSETS: Fetcher;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // 1. Intercept WebSocket upgrades on /bbs and tunnel to PTT
    if (url.pathname === '/bbs') {
      const upgradeHeader = request.headers.get('Upgrade');
      if (!upgradeHeader || upgradeHeader.toLowerCase() !== 'websocket') {
        return new Response('Expected WebSocket upgrade on /bbs', {
          status: 426,
          headers: { Upgrade: 'websocket' },
        });
      }

      const clientProto =
        request.headers.get('Sec-WebSocket-Protocol') || 'telnet';

      // Connect to PTT gateway with required Origin: https://term.ptt.cc
      let pttResponse: Response;
      try {
        pttResponse = await fetch('https://ws.ptt.cc/bbs', {
          headers: {
            Upgrade: 'websocket',
            Origin: 'https://term.ptt.cc',
            'User-Agent':
              'Mozilla/5.0 (X11; Linux x86_64) GhosPTT/1.0 (Cloudflare Worker)',
            'Sec-WebSocket-Protocol': clientProto,
          },
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return new Response(`Failed to connect to PTT upstream: ${message}`, {
          status: 502,
        });
      }

      const pttWs = pttResponse.webSocket;
      if (!pttWs) {
        return new Response(
          `PTT upstream rejected WebSocket upgrade (HTTP ${pttResponse.status})`,
          { status: 502 }
        );
      }

      // Create browser-facing WebSocket pair
      const [clientWs, serverWs] = Object.values(new WebSocketPair());

      serverWs.accept();
      pttWs.accept();

      // Bidirectional message pump
      serverWs.addEventListener('message', (event: MessageEvent) => {
        if (pttWs.readyState === WebSocket.OPEN) {
          pttWs.send(event.data);
        }
      });

      pttWs.addEventListener('message', (event: MessageEvent) => {
        if (serverWs.readyState === WebSocket.OPEN) {
          serverWs.send(event.data);
        }
      });

      const closeBoth = (code?: number, reason?: string) => {
        try {
          if (serverWs.readyState === WebSocket.OPEN) {
            serverWs.close(code || 1000, reason);
          }
        } catch {}
        try {
          if (pttWs.readyState === WebSocket.OPEN) {
            pttWs.close(code || 1000, reason);
          }
        } catch {}
      };

      serverWs.addEventListener('close', (e: CloseEvent) =>
        closeBoth(e.code, e.reason)
      );
      serverWs.addEventListener('error', () =>
        closeBoth(1006, 'Client error')
      );
      pttWs.addEventListener('close', (e: CloseEvent) =>
        closeBoth(e.code, e.reason)
      );
      pttWs.addEventListener('error', () =>
        closeBoth(1006, 'PTT upstream error')
      );

      return new Response(null, {
        status: 101,
        webSocket: clientWs,
        headers: {
          'Sec-WebSocket-Protocol': clientProto,
        },
      });
    }

    // 2. Fall back to serving static frontend assets (dist/)
    return env.ASSETS.fetch(request);
  },
};
