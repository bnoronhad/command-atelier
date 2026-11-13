import { getFullWorkspaceData } from '../../../db/index.ts';
import { computeLocalRecommendations, getTimeOfDayBucket } from '../../../lib/ai-engine.ts';
import {
  clearActionQueue,
  completeAction,
  controlTimer,
  createRoutine,
  createStudyLogEntry,
  createStudySubject,
  createSubjectTopic,
  deleteActionPermanently,
  deleteRoutine,
  deleteStudySubject,
  deleteSubjectTopic,
  skipOrRemoveAction,
  startOrQueueAction,
  toggleActionSubstep,
  triggerRoutineOrHabit,
  undoChatOperation,
  updateStudySubject,
  updateSubjectTopicStatus,
  updateUserState,
} from '../../../lib/workspace-actions.ts';

export interface RequestContext {
  apiKey?: string;
  localDate?: string | null;
  timezone?: string | null;
  dayBucket?: string | null;
}

export function verifyAccessPassword(providedPassword?: string | null): boolean {
  const requiredPassword = process.env.ACCESS_PASSWORD;
  if (!requiredPassword || !requiredPassword.trim()) return true;
  return providedPassword === requiredPassword.trim();
}

export async function handleWorkspaceGet(ctx: RequestContext = {}) {
  const workspace = await getFullWorkspaceData({
    localDate: ctx.localDate || undefined,
    timezone: ctx.timezone || undefined,
  });
  const decision = await computeLocalRecommendations(ctx.dayBucket, ctx.localDate, ctx.timezone);
  return {
    ...workspace,
    decision,
    serverHasGeminiKey: Boolean(process.env.GEMINI_API_KEY),
    passwordRequired: Boolean(process.env.ACCESS_PASSWORD),
  };
}

export async function handleWorkspacePost(body: any, ctx: RequestContext = {}) {
  const { op, payload } = body || {};
  const bucket = getTimeOfDayBucket(ctx.dayBucket);

  switch (op) {
    case 'update_state':
      await updateUserState(payload || {});
      break;
    case 'control_timer':
      await controlTimer({
        command: payload?.command || 'pause',
        minutes: payload?.minutes,
      });
      break;
    case 'start_or_queue_action':
      await startOrQueueAction({ ...(payload || {}), dayBucket: bucket });
      break;
    case 'complete_action':
      await completeAction({ ...(payload || {}), dayBucket: bucket });
      break;
    case 'clear_queue':
      await clearActionQueue();
      break;
    case 'skip_action':
      await skipOrRemoveAction(Number(payload?.action_id));
      break;
    case 'delete_action':
      await deleteActionPermanently(Number(payload?.action_id));
      break;
    case 'toggle_substep':
      await toggleActionSubstep(Number(payload?.action_id), String(payload?.substep_id));
      break;
    case 'create_routine':
      await createRoutine(payload || {});
      break;
    case 'delete_routine':
      await deleteRoutine(Number(payload?.routine_id));
      break;
    case 'trigger_routine':
      await triggerRoutineOrHabit(
        Number(payload?.routine_id),
        payload?.mode || 'queue_sequence',
        bucket
      );
      break;
    case 'create_study_log':
      await createStudyLogEntry({ ...(payload || {}), dayBucket: bucket });
      break;
    case 'create_subject':
      await createStudySubject(payload || {});
      break;
    case 'update_subject':
      await updateStudySubject(payload || {});
      break;
    case 'delete_subject':
      await deleteStudySubject(Number(payload?.id));
      break;
    case 'create_topic':
      await createSubjectTopic(payload || {});
      break;
    case 'update_topic_status':
      await updateSubjectTopicStatus(payload || {});
      break;
    case 'delete_topic':
      await deleteSubjectTopic(Number(payload?.topic_id));
      break;
    case 'undo_chat_op':
      await undoChatOperation(payload?.message_id ? Number(payload.message_id) : undefined);
      break;
  }

  return handleWorkspaceGet(ctx);
}

export function extractRequestContext(req: Request): RequestContext {
  return {
    apiKey: req.headers.get('x-gemini-api-key') || undefined,
    localDate: req.headers.get('x-user-local-date') || null,
    timezone: req.headers.get('x-user-timezone') || null,
    dayBucket: req.headers.get('x-user-day-bucket') || null,
  };
}

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
