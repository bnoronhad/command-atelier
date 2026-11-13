import {
  extractRequestContext,
  handleWorkspaceGet,
  handleWorkspacePost,
  verifyAccessPassword,
} from '../../../lib/api-handlers.ts';

export async function GET(req: Request) {
  if (!verifyAccessPassword(req.headers.get('x-access-password'))) {
    return Response.json({ error: 'Unauthorized', passwordRequired: true }, { status: 401 });
  }
  const ctx = extractRequestContext(req);
  const data = await handleWorkspaceGet(ctx);
  return Response.json(data);
}

export async function POST(req: Request) {
  if (!verifyAccessPassword(req.headers.get('x-access-password'))) {
    return Response.json({ error: 'Unauthorized', passwordRequired: true }, { status: 401 });
  }
  const ctx = extractRequestContext(req);
  const body = await req.json();
  const data = await handleWorkspacePost(body, ctx);
  return Response.json(data);
}
