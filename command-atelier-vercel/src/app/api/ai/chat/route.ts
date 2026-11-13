import { processUserChatMessage } from '../../../../lib/ai-engine.ts';
import {
  extractRequestContext,
  handleWorkspaceGet,
  type RequestContext,
  verifyAccessPassword,
} from '../../workspace/route.ts';

export async function handleChatPost(body: any, ctx: RequestContext = {}) {
  const message = String(body?.message || '').trim();
  const audioBase64 = body?.audioBase64 || undefined;
  const audioMimeType = body?.audioMimeType || undefined;
  const effectiveKey = body?.apiKey || ctx.apiKey;

  if (!message && !audioBase64) {
    return handleWorkspaceGet({ ...ctx, apiKey: effectiveKey });
  }

  const turnResult = await processUserChatMessage(
    message,
    effectiveKey,
    {
      audioBase64,
      audioMimeType,
    },
    ctx.dayBucket,
    ctx.localDate,
    ctx.timezone
  );
  const workspace = await handleWorkspaceGet({ ...ctx, apiKey: effectiveKey });
  return {
    ...workspace,
    lastTurnResult: turnResult,
  };
}

export async function POST(req: Request) {
  if (!verifyAccessPassword(req.headers.get('x-access-password'))) {
    return Response.json({ error: 'Unauthorized', passwordRequired: true }, { status: 401 });
  }
  const ctx = extractRequestContext(req);
  const body = await req.json();
  const data = await handleChatPost(body, ctx);
  return Response.json(data);
}
