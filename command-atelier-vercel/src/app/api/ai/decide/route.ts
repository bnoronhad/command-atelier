import { getGeminiRecommendations } from '../../../../lib/ai-engine.ts';
import {
  extractRequestContext,
  handleWorkspaceGet,
  type RequestContext,
  verifyAccessPassword,
} from '../../workspace/route.ts';

export async function handleDecidePost(body: any, ctx: RequestContext = {}) {
  const effectiveKey = body?.apiKey || ctx.apiKey;
  const workspace = await handleWorkspaceGet({ ...ctx, apiKey: effectiveKey });
  const decision = await getGeminiRecommendations(
    effectiveKey,
    ctx.dayBucket,
    ctx.localDate,
    ctx.timezone
  );
  return {
    ...workspace,
    decision,
  };
}

export async function POST(req: Request) {
  if (!verifyAccessPassword(req.headers.get('x-access-password'))) {
    return Response.json({ error: 'Unauthorized', passwordRequired: true }, { status: 401 });
  }
  const ctx = extractRequestContext(req);
  const body = await req.json().catch(() => ({}));
  const data = await handleDecidePost(body, ctx);
  return Response.json(data);
}
