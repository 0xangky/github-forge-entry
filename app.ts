// HTTP routing and the small amount of plumbing shared by every surface.
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { ForgeStore } from './store.ts';
import { handleGit } from './git.ts';
import { handleRest, handleGraphQL, handleMcp, sendJson } from './api.ts';

const MAX_BODY = 128 * 1024 * 1024;

function pathOf(req: IncomingMessage): { pathname: string; query: URLSearchParams } {
  try {
    const url = new URL(req.url ?? '/', 'http://entry');
    return { pathname: url.pathname, query: url.searchParams };
  } catch {
    return { pathname: '/', query: new URLSearchParams() };
  }
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const b = Buffer.from(chunk as Uint8Array);
    total += b.length;
    if (total > MAX_BODY) break;
    chunks.push(b);
  }
  return Buffer.concat(chunks);
}

/** Build the forge HTTP server. It binds nothing until the caller listens. */
export function createApp(): Server {
  const store = new ForgeStore();
  let requestCounter = 0;
  const expectedToken = process.env.MAKEFUN_SHOP_TOKEN ?? '';

  return createServer(async (req, res) => {
    const { pathname, query } = pathOf(req);
    const method = req.method ?? 'GET';
    requestCounter += 1;
    res.setHeader('x-github-request-id', `forge-${requestCounter}`);

    if (method === 'GET' && pathname === '/healthz') {
      sendJson(res, 200, { ok: true });
      return;
    }

    const isApi = pathname === '/api/graphql' || pathname === '/mcp' || pathname === '/api/v3' || pathname.startsWith('/api/v3/');
    const isGit = /^\/[^/]+\/[^/]+\.git(?:\/.*)?$/.test(pathname);
    if (!isApi && !isGit) { sendJson(res, 404, { message: 'Not Found' }); return; }

    const auth = req.headers.authorization ?? '';
    const tokenOk = auth === `Bearer ${expectedToken}` && expectedToken !== '';
    if (!tokenOk) { sendJson(res, 401, { message: 'Bad credentials' }); return; }

    let body: Buffer;
    if (method === 'GET' && !req.headers['content-length'] && !req.headers['transfer-encoding']) {
      body = Buffer.alloc(0);
    } else {
      try { body = await readBody(req); }
      catch { sendJson(res, 400, { message: 'Could not read the request body' }); return; }
    }

    if (isApi) {
      const text = body.toString('utf8');
      let parsed: unknown;
      let jsonError = false;
      if (text.trim() !== '') {
        try { parsed = JSON.parse(text); } catch { jsonError = true; }
      }
      const apiRequest = { method, pathname, query, host: req.headers.host ?? '127.0.0.1', bodyText: text, json: parsed, jsonError };
      if (pathname === '/api/graphql') {
        if (method !== 'POST') { sendJson(res, 405, { message: 'Method Not Allowed' }); return; }
        handleGraphQL(store, res, parsed, jsonError);
        return;
      }
      if (pathname === '/mcp') {
        handleMcp(store, res, method, text, parsed, jsonError);
        return;
      }
      handleRest(store, apiRequest, res);
      return;
    }

    handleGit(store, req, res, pathname, body);
  });
}
