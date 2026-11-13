import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  handleWorkspaceGet,
  handleWorkspacePost,
  type RequestContext,
  verifyAccessPassword,
} from './src/app/api/workspace/route.ts';
import { handleChatPost } from './src/app/api/ai/chat/route.ts';
import { handleDecidePost } from './src/app/api/ai/decide/route.ts';

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = join(process.cwd(), 'public');

function readBody(req: any): Promise<any> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        resolve({});
      }
    });
  });
}

function getCtxFromNodeReq(req: any): RequestContext {
  return {
    apiKey: (req.headers['x-gemini-api-key'] as string) || undefined,
    localDate: (req.headers['x-user-local-date'] as string) || null,
    timezone: (req.headers['x-user-timezone'] as string) || null,
    dayBucket: (req.headers['x-user-day-bucket'] as string) || null,
  };
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://localhost:${PORT}`);

    if (url.pathname.startsWith('/api/')) {
      const providedPassword = (req.headers['x-access-password'] as string) || null;
      if (!verifyAccessPassword(providedPassword)) {
        res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'Unauthorized', passwordRequired: true }));
        return;
      }
    }

    const ctx = getCtxFromNodeReq(req);

    if (url.pathname === '/api/workspace' && req.method === 'GET') {
      const data = await handleWorkspaceGet(ctx);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(data));
      return;
    }

    if (url.pathname === '/api/workspace' && req.method === 'POST') {
      const body = await readBody(req);
      const data = await handleWorkspacePost(body, ctx);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(data));
      return;
    }

    if (url.pathname === '/api/ai/chat' && req.method === 'POST') {
      const body = await readBody(req);
      const data = await handleChatPost(body, ctx);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(data));
      return;
    }

    if (url.pathname === '/api/ai/decide' && req.method === 'POST') {
      const body = await readBody(req);
      const data = await handleDecidePost(body, ctx);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(data));
      return;
    }

    if (url.pathname === '/styles.css') {
      const css = readFileSync(join(PUBLIC_DIR, 'styles.css'), 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8' });
      res.end(css);
      return;
    }

    if (url.pathname === '/app.js') {
      const js = readFileSync(join(PUBLIC_DIR, 'app.js'), 'utf8');
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
      res.end(js);
      return;
    }

    const html = readFileSync(join(PUBLIC_DIR, 'index.html'), 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  } catch (err: any) {
    res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: err?.message || 'Internal Server Error' }));
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Action & Study Command Center listening on http://localhost:${PORT}`);
});
