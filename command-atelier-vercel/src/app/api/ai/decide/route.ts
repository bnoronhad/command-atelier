import {
  extractRequestContext,
  handleDecidePost,
  verifyAccessPassword,
} from '../../../../lib/api-handlers.ts';

export async function POST(req: Request) {
  if (!verifyAccessPassword(req.headers.get('x-access-password'))) {
    return Response.json({ error: 'Unauthorized', passwordRequired: true }, { status: 401 });
  }
  const ctx = extractRequestContext(req);
  const body = await req.json().catch(() => ({}));
  const data = await handleDecidePost(body, ctx);
  return Response.json(data);
}
