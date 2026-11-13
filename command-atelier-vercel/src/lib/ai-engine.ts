import { execSql, getFullWorkspaceData, queryJson, sqlLiteral } from '../db/index.ts';
import type {
  ActionCategory,
  ProposedActionItem,
  StudyLogRecord,
  StudyMode,
  TimeOfDayWindow,
  TopicStatus,
} from '../db/schema.ts';
import {
  captureFullUndoSnapshot,
  clearActionQueue,
  completeAction,
  controlTimer,
  createRoutine,
  createStudyLogEntry,
  createStudySubject,
  createSubjectTopic,
  deleteRoutine,
  deleteStudySubject,
  startOrQueueAction,
  triggerRoutineOrHabit,
  updateSubjectTopicStatus,
  updateUserState,
} from './workspace-actions.ts';

export interface RecommendationChoice {
  slot: 'primary' | 'lighter_alternative' | 'study_or_habit_alternative';
  badge: string;
  title: string;
  category: ActionCategory;
  estimated_minutes: number;
  study_mode: StudyMode | null;
  subject_name: string | null;
  reasoning: string;
  source_type: 'existing_action' | 'recurring_habit' | 'study_followup';
  source_id: number | null;
}

export interface DecisionResponse {
  provider: 'gemini' | 'local_engine';
  model: string;
  current_time_of_day: TimeOfDayWindow;
  last_study_mode: StudyMode | null;
  recommendations: RecommendationChoice[];
}

export interface ClientUiEffects {
  switchView?: 'now' | 'queue' | 'syllabus' | 'routines' | null;
  syllabusSubtab?: 'subjects' | 'logs' | null;
  timerCommand?: 'pause' | 'resume' | 'add_minutes' | 'set_minutes' | null;
  timerMinutes?: number | null;
  theme?: 'dark' | 'light' | null;
  spokenSummary?: string;
  lastMessageId?: number;
  transcribedText?: string | null;
  errorBanner?: string | null;
}

export function getTimeOfDayBucket(overrideBucket?: string | null): TimeOfDayWindow {
  if (
    overrideBucket === 'morning' ||
    overrideBucket === 'afternoon' ||
    overrideBucket === 'evening' ||
    overrideBucket === 'night'
  ) {
    return overrideBucket;
  }
  const hr = new Date().getHours();
  if (hr >= 5 && hr < 12) return 'morning';
  if (hr >= 12 && hr < 17) return 'afternoon';
  if (hr >= 17 && hr < 22) return 'evening';
  return 'night';
}

const STUDY_MODE_LABELS: Record<StudyMode, string> = {
  practice_paper: 'Practice Paper',
  paper_correction: 'Paper Correction',
  anki_review: 'Anki Review',
  active_exploration: 'Active Exploration',
  problem_set: 'Problem Set',
  summary_notes: 'Summary Notes',
};

export function formatStudyMode(mode: StudyMode | null | undefined): string {
  if (!mode) return 'General';
  return STUDY_MODE_LABELS[mode] || mode;
}

export async function computeLocalRecommendations(
  dayBucketOverride?: string | null,
  localDate?: string | null,
  timezone?: string | null
): Promise<DecisionResponse> {
  const data = await getFullWorkspaceData({
    localDate: localDate || undefined,
    timezone: timezone || undefined,
  });
  const { userState, actions, studyLogs, routines, subjects } = data;
  const currentBucket = getTimeOfDayBucket(dayBucketOverride);
  const availMins = userState?.available_minutes || 60;
  const lastLog: StudyLogRecord | undefined = studyLogs[0];
  const lastStudyMode: StudyMode | null = lastLog?.study_mode || null;

  const subjectMap = new Map(subjects.map((s) => [s.id, s.name]));

  const candidateActions = actions.filter(
    (a) => a.status === 'queued' || a.status === 'backlog'
  );

  interface ScoredCandidate {
    choice: RecommendationChoice;
    score: number;
    isLighter: boolean;
    isHabitOrStudyFollowup: boolean;
  }

  const scored: ScoredCandidate[] = [];

  for (const act of candidateActions) {
    let score = 50;
    const reasons: string[] = [];

    if (act.estimated_minutes <= availMins) {
      score += 25;
      reasons.push(`Fits your ${availMins}m window (${act.estimated_minutes}m)`);
    } else {
      const overrun = act.estimated_minutes - availMins;
      score -= Math.min(40, overrun);
      reasons.push(`Over your ${availMins}m window (${act.estimated_minutes}m)`);
    }

    if (act.time_of_day_preference === currentBucket) {
      score += 18;
      reasons.push(`Aligned with ${currentBucket}`);
    } else if (act.time_of_day_preference === 'anytime') {
      score += 6;
    }

    if (act.study_mode && lastStudyMode) {
      if (lastStudyMode === 'practice_paper' && act.study_mode === 'paper_correction') {
        score += 35;
        reasons.push('Direct follow-up to your last Practice Paper');
      } else if (act.study_mode !== lastStudyMode) {
        score += 16;
        reasons.push(`Alternates from ${formatStudyMode(lastStudyMode)}`);
      } else {
        score -= 12;
      }
    }

    if (act.status === 'queued') {
      score += 20;
      reasons.push('Queued for today');
    }

    const subjName = act.study_subject_id ? subjectMap.get(act.study_subject_id) || null : null;

    scored.push({
      score,
      isLighter: act.estimated_minutes <= Math.min(30, availMins),
      isHabitOrStudyFollowup:
        act.category === 'study' ||
        act.study_mode === 'anki_review' ||
        act.study_mode === 'paper_correction',
      choice: {
        slot: 'primary',
        badge: 'Best Fit Now',
        title: act.title,
        category: act.category,
        estimated_minutes: act.estimated_minutes,
        study_mode: act.study_mode,
        subject_name: subjName,
        reasoning: reasons.slice(0, 2).join(' · ') || 'Ready in your queue',
        source_type: 'existing_action',
        source_id: act.id,
      },
    });
  }

  for (const r of routines) {
    if (r.routine_type === 'recurring_habit' && !r.completed_today) {
      const aligned = r.time_of_day_window === currentBucket || r.time_of_day_window === 'anytime';
      const mins = r.estimated_minutes || 20;
      const score = (aligned ? 78 : 54) + (mins <= availMins ? 15 : -10);
      scored.push({
        score,
        isLighter: mins <= 25,
        isHabitOrStudyFollowup: true,
        choice: {
          slot: 'study_or_habit_alternative',
          badge: 'Recurring Habit',
          title: r.name,
          category: r.category || 'study',
          estimated_minutes: mins,
          study_mode: r.steps_json?.[0]?.study_mode || null,
          subject_name: null,
          reasoning: `${r.time_of_day_window} habit · Not completed today`,
          source_type: 'recurring_habit',
          source_id: r.id,
        },
      });
    }
  }

  // If the user has logged a practice paper with follow-up needed, suggest a study follow-up
  if (lastLog && (lastLog.study_mode === 'practice_paper' || lastLog.needs_followup_next)) {
    const subjName = lastLog.subject_id ? subjectMap.get(lastLog.subject_id) || 'Study' : 'Study';
    const followupTitle = lastLog.needs_followup_next
      ? `${subjName}: ${lastLog.needs_followup_next}`
      : `${subjName}: Paper Correction (${lastLog.topic_covered})`;

    if (!scored.some((s) => s.choice.title === followupTitle)) {
      const suggestedMins = Math.min(availMins, 40);
      scored.push({
        score: 92,
        isLighter: suggestedMins <= 30,
        isHabitOrStudyFollowup: true,
        choice: {
          slot: 'primary',
          badge: 'Study Follow-Up',
          title: followupTitle,
          category: 'study',
          estimated_minutes: suggestedMins,
          study_mode:
            lastLog.study_mode === 'practice_paper' ? 'paper_correction' : 'active_exploration',
          subject_name: subjName,
          reasoning: `Direct follow-up from your last session (${lastLog.topic_covered})`,
          source_type: 'study_followup',
          source_id: lastLog.subject_id,
        },
      });
    }
  }

  // Suggest topics from existing user subjects if queue is light
  if (scored.length < 3 && subjects.length > 0) {
    for (const subj of subjects) {
      if (scored.length >= 3) break;
      const subjTopics = (subj.topics || []).filter((t) => t.status !== 'solid');
      const targetTopic =
        subjTopics.find((t) => t.status === 'needs_correction') ||
        subjTopics.find((t) => t.status === 'needs_practice_paper') ||
        subjTopics.find((t) => t.status === 'needs_exploration') ||
        subjTopics[0];

      const suggestedMode: StudyMode =
        targetTopic?.status === 'needs_correction'
          ? 'paper_correction'
          : targetTopic?.status === 'needs_practice_paper'
            ? 'practice_paper'
            : 'active_exploration';
      const suggestedMins = Math.min(availMins, suggestedMode === 'paper_correction' ? 35 : 45);
      const title = targetTopic
        ? `${subj.name}: ${targetTopic.title}`
        : `${subj.name}: Focused Study Session`;

      if (!scored.some((s) => s.choice.title === title)) {
        scored.push({
          score: subj.priority === 'high' ? 76 : 64,
          isLighter: suggestedMins <= 30,
          isHabitOrStudyFollowup: true,
          choice: {
            slot: 'study_or_habit_alternative',
            badge: 'Syllabus Priority',
            title,
            category: 'study',
            estimated_minutes: suggestedMins,
            study_mode: suggestedMode,
            subject_name: subj.name,
            reasoning: targetTopic
              ? `Syllabus topic marked "${targetTopic.status.replace(/_/g, ' ')}"`
              : `${subj.priority.toUpperCase()} priority subject`,
            source_type: 'study_followup',
            source_id: subj.id,
          },
        });
      }
    }
  }

  if (scored.length === 0) {
    return {
      provider: 'local_engine',
      model: 'rule-based-v2',
      current_time_of_day: currentBucket,
      last_study_mode: lastStudyMode,
      recommendations: [],
    };
  }

  scored.sort((a, b) => b.score - a.score);

  const primary = { ...scored[0].choice, slot: 'primary' as const, badge: 'Best Fit Now' };
  const usedTitles = new Set<string>([primary.title]);

  const lighterCandidate =
    scored.find((s) => !usedTitles.has(s.choice.title) && s.isLighter) ||
    scored.find((s) => !usedTitles.has(s.choice.title));

  const recommendations: RecommendationChoice[] = [primary];

  if (lighterCandidate) {
    usedTitles.add(lighterCandidate.choice.title);
    recommendations.push({
      ...lighterCandidate.choice,
      slot: 'lighter_alternative',
      badge: 'Lighter Option',
    });
  }

  const thirdCandidate =
    scored.find((s) => !usedTitles.has(s.choice.title) && s.isHabitOrStudyFollowup) ||
    scored.find((s) => !usedTitles.has(s.choice.title));

  if (thirdCandidate) {
    usedTitles.add(thirdCandidate.choice.title);
    recommendations.push({
      ...thirdCandidate.choice,
      slot: 'study_or_habit_alternative',
      badge:
        thirdCandidate.choice.source_type === 'recurring_habit'
          ? 'Habit Check-In'
          : 'Study / Alternation',
    });
  }

  return {
    provider: 'local_engine',
    model: 'rule-based-v2',
    current_time_of_day: currentBucket,
    last_study_mode: lastStudyMode,
    recommendations,
  };
}

export async function getGeminiRecommendations(
  apiKey?: string,
  dayBucketOverride?: string | null,
  localDate?: string | null,
  timezone?: string | null
): Promise<DecisionResponse> {
  const localDecision = computeLocalRecommendations(dayBucketOverride, localDate, timezone);
  const effectiveKey = (apiKey || process.env.GEMINI_API_KEY || '').trim();
  if (!effectiveKey || localDecision.recommendations.length === 0) {
    return localDecision;
  }

  try {
    const data = getFullWorkspaceData({
      localDate: localDate || undefined,
      timezone: timezone || undefined,
    });
    const modelToUse = data.userState?.gemini_model || 'gemini-2.5-flash';
    const prompt = `You are an executive action & study decision engine.
Given the user's current context and local candidate recommendations, refine the 3 recommendation reasonings and ordering so they best fit:
- Available time window: ${data.userState?.available_minutes || 60} minutes
- Context & Energy: ${data.userState?.context_location || 'home'} / ${data.userState?.energy_level || 'medium'}
- Time of day: ${localDecision.current_time_of_day}
- Last study mode: ${localDecision.last_study_mode || 'none'}
- Unified Exam Target: ${data.userState?.exam_name || 'none'} (${data.userState?.exam_target_date || 'unscheduled'})
- Local candidates: ${JSON.stringify(localDecision.recommendations)}

Return ONLY valid JSON with shape:
{
  "recommendations": [
    {
      "slot": "primary" | "lighter_alternative" | "study_or_habit_alternative",
      "badge": string,
      "title": string,
      "category": "study" | "work" | "personal" | "health" | "admin",
      "estimated_minutes": number,
      "study_mode": "practice_paper" | "paper_correction" | "anki_review" | "active_exploration" | "problem_set" | "summary_notes" | null,
      "subject_name": string | null,
      "reasoning": string,
      "source_type": "existing_action" | "recurring_habit" | "study_followup",
      "source_id": number | null
    }
  ]
}`;

    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${modelToUse}:generateContent?key=${encodeURIComponent(effectiveKey)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.2,
            responseMimeType: 'application/json',
          },
        }),
      }
    );

    if (!resp.ok) {
      return localDecision;
    }

    const json: any = await resp.json();
    const rawText = json?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!rawText) return localDecision;
    const parsed = JSON.parse(rawText);
    if (Array.isArray(parsed?.recommendations) && parsed.recommendations.length > 0) {
      return {
        provider: 'gemini',
        model: modelToUse,
        current_time_of_day: localDecision.current_time_of_day,
        last_study_mode: localDecision.last_study_mode,
        recommendations: parsed.recommendations.slice(0, 3),
      };
    }
  } catch {
    // Fallback cleanly to local decision
  }

  return localDecision;
}

export async function processUserChatMessage(
  userMessage: string,
  apiKey?: string,
  audioPayload?: { audioBase64?: string; audioMimeType?: string },
  dayBucketOverride?: string | null,
  localDate?: string | null,
  timezone?: string | null
): Promise<{
  reply: string;
  appliedActions: string[];
  proposedActions: ProposedActionItem[];
  uiEffects: ClientUiEffects;
}> {
  const preTurnSnapshot = await captureFullUndoSnapshot();
  const effectiveKey = (apiKey || process.env.GEMINI_API_KEY || '').trim();
  const hasAudio = Boolean(audioPayload?.audioBase64);

  if (hasAudio && !effectiveKey) {
    const errText =
      'Voice transcription requires your Google Gemini API key. Click "Gemini Key" (bottom left) and paste your API key so voice recordings can be transcribed and executed.';
    return {
      reply: errText,
      appliedActions: [],
      proposedActions: [],
      uiEffects: {
        errorBanner: errText,
        spokenSummary: 'Please add your Gemini API key in Settings to use voice commands.',
      },
    };
  }

  const initialMessageText = userMessage.trim() || (hasAudio ? '[Voice Command]' : '');

  await execSql(`
    INSERT INTO chat_messages (role, content, applied_operations, proposed_actions)
    VALUES ('user', ${sqlLiteral(initialMessageText)}, '[]'::jsonb, '[]'::jsonb);
  `);
  const userMsgRows = await queryJson<Array<{ id: number }>>(`SELECT MAX(id) AS id FROM chat_messages`);
  const userMessageId = userMsgRows[0]?.id;

  const data = await getFullWorkspaceData({
    localDate: localDate || undefined,
    timezone: timezone || undefined,
  });
  const currentBucket = getTimeOfDayBucket(dayBucketOverride);
  const appliedActions: string[] = [];
  const proposedActions: ProposedActionItem[] = [];
  const uiEffects: ClientUiEffects = {};
  let assistantReply = '';

  const activeAction = data.actions.find((a) => a.status === 'active') || null;
  const queuedActions = data.actions.filter((a) => a.status === 'queued');
  const backlogActions = data.actions.filter((a) => a.status === 'backlog');
  const allTopics = data.subjects.flatMap((s) => s.topics || []);

  if (effectiveKey) {
    const preferredModel = data.userState?.gemini_model || 'gemini-2.5-flash';
    const systemPrompt = `You are the Live Executive Co-Pilot for a personal Action, Routine & Study Command Center ("Command Atelier").
You have direct live control over the entire application state, database, study tracker, syllabus, routines, active timer, and UI navigation.

Current Workspace State:
- Local Date: ${localDate || new Date().toISOString().slice(0, 10)}
- Current Time of Day: ${currentBucket}
- Available Window: ${data.userState?.available_minutes || 60}m
- Context Location: ${data.userState?.context_location || 'home'}
- Energy Level: ${data.userState?.energy_level || 'medium'}
- Unified Exam Horizon: ${data.userState?.exam_name || 'Unset'} (${data.userState?.exam_target_date || 'No date set'})
- Active Timer: running=${Boolean(data.userState?.timer_running)}, remaining_seconds=${data.userState?.timer_remaining_seconds ?? 0}
- Active Action Now: ${activeAction ? JSON.stringify({ id: activeAction.id, title: activeAction.title, category: activeAction.category, estimated_minutes: activeAction.estimated_minutes, study_mode: activeAction.study_mode }) : 'NONE'}
- Queued Actions (${queuedActions.length}): ${JSON.stringify(queuedActions.map((a) => ({ id: a.id, title: a.title, mins: a.estimated_minutes, category: a.category, study_mode: a.study_mode })))}
- Backlog Actions (${backlogActions.length}): ${JSON.stringify(backlogActions.map((a) => ({ id: a.id, title: a.title, mins: a.estimated_minutes, category: a.category, study_mode: a.study_mode })))}
- Subjects (${data.subjects.length}): ${JSON.stringify(data.subjects.map((s) => ({ id: s.id, name: s.name, code: s.code_or_area, priority: s.priority, notes: s.current_focus_notes })))}
- Topics (${allTopics.length}): ${JSON.stringify(allTopics.map((t) => ({ id: t.id, subject_id: t.subject_id, title: t.title, status: t.status })))}
- Recent Study Logs (last 5): ${JSON.stringify(data.studyLogs.slice(0, 5))}
- Routines & Habits (${data.routines.length}): ${JSON.stringify(data.routines.map((r) => ({ id: r.id, name: r.name, type: r.routine_type, window: r.time_of_day_window, mins: r.estimated_minutes, completed_today: r.completed_today })))}

Rules:
1. If audio is attached, first transcribe the user's speech accurately into "transcribed_user_speech", and treat that transcription as the user's instruction.
2. When the user gives a direct instruction to change anything in the app (e.g., "I have 35 minutes", "Set my exam to Bar Exam on 2026-11-20", "Start a 40m paper correction", "Queue Anki review", "Clear my queue", "Pause timer", "Add 10 minutes to timer", "Log 50m practice paper for Physics", "Add subject Linear Algebra code MATH-201", "Add topic Eigenvalues under Linear Algebra", "Mark Eigenvalues as solid", "Create a morning routine", "Switch to syllabus view", "Switch to light mode"), include the matching operations in "operations" and/or "ui_effects" so they execute immediately on the fly!
3. Never invent fake placeholder subjects or tasks the user did not ask for.
4. Keep "reply" concise, sharp, and natural (1-3 sentences), confirming what you adjusted or recommending the next move.
5. Set "spoken_summary" to a 1-sentence natural spoken confirmation suitable for voice readback.

Return ONLY valid JSON matching this structure:
{
  "transcribed_user_speech": string | null,
  "reply": string,
  "spoken_summary": string,
  "ui_effects": {
    "switchView": "now" | "queue" | "syllabus" | "routines" | null,
    "syllabusSubtab": "subjects" | "logs" | null,
    "timerCommand": "pause" | "resume" | "add_minutes" | "set_minutes" | null,
    "timerMinutes": number | null,
    "theme": "dark" | "light" | null
  },
  "operations": [
    {
      "op": "update_state" | "start_action" | "queue_action" | "complete_active_action" | "clear_queue" | "control_timer" | "log_study_session" | "create_subject" | "delete_subject" | "create_topic" | "update_topic_status" | "create_routine" | "delete_routine" | "trigger_routine",
      "available_minutes": number (optional, for update_state),
      "context_location": "home" | "office" | "library" | "out" | "deep-work-ready" (optional, for update_state),
      "energy_level": "low" | "medium" | "high" (optional, for update_state),
      "exam_name": string (optional, for update_state),
      "exam_target_date": string (optional, YYYY-MM-DD for update_state),
      "timer_command": "pause" | "resume" | "add_minutes" | "set_minutes" (optional, for control_timer),
      "timer_minutes": number (optional, for control_timer),
      "action_id": number | null (optional, if starting/queuing an existing action),
      "title": string (optional, for start_action, queue_action, log_study_session, or create_topic),
      "notes": string (optional),
      "category": "study" | "work" | "personal" | "health" | "admin" (optional),
      "estimated_minutes": number (optional),
      "study_mode": "practice_paper" | "paper_correction" | "anki_review" | "active_exploration" | "problem_set" | "summary_notes" | null (optional),
      "subject_name": string | null (optional),
      "code_or_area": string (optional, for create_subject),
      "priority": "high" | "medium" | "low" (optional, for create_subject),
      "topic_id": number (optional, for update_topic_status),
      "topic_status": "untouched" | "needs_exploration" | "needs_practice_paper" | "needs_correction" | "solid" (optional, for create_topic or update_topic_status),
      "duration_minutes": number (optional, for log_study_session or complete_active_action),
      "needs_followup_next": string (optional, for log_study_session),
      "routine_id": number (optional, for trigger_routine or delete_routine),
      "routine_name": string (optional, for create_routine),
      "routine_type": "block_sequence" | "recurring_habit" (optional, for create_routine),
      "time_of_day_window": "morning" | "afternoon" | "evening" | "night" | "anytime" (optional, for create_routine),
      "steps": [{ "title": string, "estimated_minutes": number, "category": "study" | "work" | "personal" | "health" | "admin" }] (optional, for create_routine)
    }
  ]
}`;

    const userParts: any[] = [];
    if (audioPayload?.audioBase64) {
      userParts.push({
        inlineData: {
          mimeType: audioPayload.audioMimeType || 'audio/webm',
          data: audioPayload.audioBase64,
        },
      });
    }
    userParts.push({
      text:
        userMessage.trim() ||
        'Transcribe the attached voice audio and execute the user instruction in the workspace.',
    });

    try {
      const modelsToTry = Array.from(new Set([preferredModel, 'gemini-2.5-flash', 'gemini-2.0-flash']));
      let parsed: any = null;
      let lastErrorStatus = 0;
      let lastErrorMessage = '';

      for (const modelName of modelsToTry) {
        const resp = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${encodeURIComponent(effectiveKey)}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              systemInstruction: { parts: [{ text: systemPrompt }] },
              contents: [{ role: 'user', parts: userParts }],
              generationConfig: {
                temperature: 0.2,
                responseMimeType: 'application/json',
              },
            }),
          }
        );

        if (resp.ok) {
          const json: any = await resp.json();
          const rawText = json?.candidates?.[0]?.content?.parts?.[0]?.text;
          if (rawText) {
            parsed = JSON.parse(rawText);
            break;
          }
        } else {
          lastErrorStatus = resp.status;
          try {
            const errJson: any = await resp.json();
            lastErrorMessage = errJson?.error?.message || `HTTP ${resp.status}`;
          } catch {
            lastErrorMessage = `HTTP ${resp.status}`;
          }
          if (resp.status === 400 || resp.status === 401 || resp.status === 403) {
            break;
          }
        }
      }

      if (parsed) {
        assistantReply = parsed.reply || 'Done — workspace updated.';
        if (parsed.transcribed_user_speech && userMessageId) {
          const cleanTranscript = String(parsed.transcribed_user_speech).trim();
          if (cleanTranscript) {
            uiEffects.transcribedText = cleanTranscript;
            await execSql(`
              UPDATE chat_messages
              SET content = ${sqlLiteral(cleanTranscript)}
              WHERE id = ${Number(userMessageId)};
            `);
          }
        }

        if (parsed.spoken_summary) {
          uiEffects.spokenSummary = String(parsed.spoken_summary);
        }
        if (parsed.ui_effects && typeof parsed.ui_effects === 'object') {
          if (parsed.ui_effects.switchView) uiEffects.switchView = parsed.ui_effects.switchView;
          if (parsed.ui_effects.syllabusSubtab)
            uiEffects.syllabusSubtab = parsed.ui_effects.syllabusSubtab;
          if (parsed.ui_effects.timerCommand) {
            uiEffects.timerCommand = parsed.ui_effects.timerCommand;
            uiEffects.timerMinutes = parsed.ui_effects.timerMinutes ?? null;
          }
          if (parsed.ui_effects.theme) uiEffects.theme = parsed.ui_effects.theme;
        }

        if (uiEffects.timerCommand) {
          await controlTimer({
            command: uiEffects.timerCommand,
            minutes: uiEffects.timerMinutes ?? undefined,
          });
          appliedActions.push(
            `Timer: ${uiEffects.timerCommand}${uiEffects.timerMinutes ? ` (${uiEffects.timerMinutes}m)` : ''}`
          );
        }

        const latestSubjects = async () =>
          (
            await getFullWorkspaceData({
              localDate: localDate || undefined,
              timezone: timezone || undefined,
            })
          ).subjects;

        const findSubjectId = async (name?: string | null) => {
          if (!name) return null;
          const lower = name.toLowerCase();
          const subjs = await latestSubjects();
          const match = subjs.find(
            (s) =>
              s.name.toLowerCase().includes(lower) ||
              lower.includes(s.name.toLowerCase()) ||
              (s.code_or_area && s.code_or_area.toLowerCase().includes(lower))
          );
          return match ? match.id : null;
        };

        if (Array.isArray(parsed.operations)) {
          for (const op of parsed.operations) {
            if (op.op === 'update_state') {
              await updateUserState({
                available_minutes: op.available_minutes,
                context_location: op.context_location,
                energy_level: op.energy_level,
                exam_name: op.exam_name,
                exam_target_date: op.exam_target_date,
              });
              const parts: string[] = [];
              if (op.available_minutes !== undefined)
                parts.push(`Window -> ${op.available_minutes}m`);
              if (op.context_location) parts.push(`Context -> ${op.context_location}`);
              if (op.energy_level) parts.push(`Energy -> ${op.energy_level}`);
              if (op.exam_name || op.exam_target_date) parts.push('Updated Exam Horizon');
              if (parts.length > 0) appliedActions.push(parts.join(', '));
            } else if (op.op === 'control_timer' && op.timer_command) {
              await controlTimer({
                command: op.timer_command,
                minutes: op.timer_minutes,
              });
              uiEffects.timerCommand = op.timer_command;
              uiEffects.timerMinutes = op.timer_minutes ?? null;
              appliedActions.push(
                `Timer: ${op.timer_command}${op.timer_minutes ? ` (${op.timer_minutes}m)` : ''}`
              );
            } else if (op.op === 'start_action') {
              const subjId = await findSubjectId(op.subject_name);
              await startOrQueueAction({
                action_id: op.action_id || undefined,
                title: op.title,
                notes: op.notes || '',
                category: op.category || 'study',
                estimated_minutes: op.estimated_minutes || 30,
                study_mode: op.study_mode || null,
                study_subject_id: subjId,
                mode: 'start_now',
                dayBucket: currentBucket,
              });
              uiEffects.switchView = 'now';
              appliedActions.push(`Started: ${op.title || 'Action'}`);
            } else if (op.op === 'queue_action') {
              const subjId = await findSubjectId(op.subject_name);
              await startOrQueueAction({
                action_id: op.action_id || undefined,
                title: op.title,
                notes: op.notes || '',
                category: op.category || 'study',
                estimated_minutes: op.estimated_minutes || 30,
                study_mode: op.study_mode || null,
                study_subject_id: subjId,
                mode: 'queue',
                dayBucket: currentBucket,
              });
              appliedActions.push(`Queued: ${op.title || 'Action'}`);
            } else if (op.op === 'complete_active_action') {
              if (activeAction) {
                await completeAction({
                  action_id: activeAction.id,
                  actual_minutes: op.duration_minutes || activeAction.estimated_minutes,
                  dayBucket: currentBucket,
                });
                appliedActions.push(`Completed: ${activeAction.title}`);
              }
            } else if (op.op === 'clear_queue') {
              await clearActionQueue();
              appliedActions.push('Cleared Today Queue -> Backlog');
            } else if (op.op === 'log_study_session') {
              const subjId = await findSubjectId(op.subject_name);
              await createStudyLogEntry({
                subject_id: subjId,
                study_mode: op.study_mode || 'active_exploration',
                topic_covered: op.title || op.notes || 'Study Session',
                duration_minutes: op.duration_minutes || 45,
                perceived_outcome: 'Logged via AI Co-Pilot',
                needs_followup_next: op.needs_followup_next || '',
                dayBucket: currentBucket,
              });
              appliedActions.push(
                `Logged ${op.duration_minutes || 45}m ${formatStudyMode(op.study_mode)}`
              );
            } else if (op.op === 'create_subject' && (op.subject_name || op.title)) {
              const sName = op.subject_name || op.title;
              await createStudySubject({
                name: sName,
                code_or_area: op.code_or_area || sName.slice(0, 8).toUpperCase(),
                priority: op.priority || 'high',
                current_focus_notes: op.notes || '',
              });
              appliedActions.push(`Added Subject: ${sName}`);
            } else if (op.op === 'delete_subject' && (op.subject_name || op.title)) {
              const subjId = await findSubjectId(op.subject_name || op.title);
              if (subjId) {
                await deleteStudySubject(subjId);
                appliedActions.push(`Deleted Subject: ${op.subject_name || op.title}`);
              }
            } else if (op.op === 'create_topic' && op.title) {
              const subjs = await latestSubjects();
              const subjId = (await findSubjectId(op.subject_name)) || subjs[0]?.id;
              if (subjId) {
                await createSubjectTopic({
                  subject_id: subjId,
                  title: op.title,
                  status: op.topic_status || 'untouched',
                  notes: op.notes || '',
                });
                appliedActions.push(`Added Topic: ${op.title}`);
              }
            } else if (op.op === 'update_topic_status') {
              const subjs = await latestSubjects();
              const currentTopics = subjs.flatMap((s) => s.topics || []);
              const targetTopic = currentTopics.find(
                (t) =>
                  (op.topic_id && t.id === Number(op.topic_id)) ||
                  (op.title && t.title.toLowerCase().includes(String(op.title).toLowerCase()))
              );
              if (targetTopic && op.topic_status) {
                await updateSubjectTopicStatus({
                  topic_id: targetTopic.id,
                  status: op.topic_status as TopicStatus,
                });
                appliedActions.push(`Topic "${targetTopic.title}" -> ${op.topic_status}`);
              }
            } else if (op.op === 'create_routine' && (op.routine_name || op.title)) {
              const rName = op.routine_name || op.title;
              await createRoutine({
                name: rName,
                routine_type: op.routine_type || 'recurring_habit',
                time_of_day_window: op.time_of_day_window || 'anytime',
                estimated_minutes: op.estimated_minutes || 25,
                category: op.category || 'study',
                steps_json: Array.isArray(op.steps) ? op.steps : undefined,
              });
              appliedActions.push(`Created Routine: ${rName}`);
            } else if (op.op === 'delete_routine') {
              const targetRoutine = data.routines.find(
                (r) =>
                  (op.routine_id && r.id === Number(op.routine_id)) ||
                  ((op.routine_name || op.title) &&
                    r.name.toLowerCase().includes(String(op.routine_name || op.title).toLowerCase()))
              );
              if (targetRoutine) {
                await deleteRoutine(targetRoutine.id);
                appliedActions.push(`Deleted Routine: ${targetRoutine.name}`);
              }
            } else if (op.op === 'trigger_routine') {
              const targetRoutine = data.routines.find(
                (r) =>
                  (op.routine_id && r.id === Number(op.routine_id)) ||
                  ((op.routine_name || op.title) &&
                    r.name.toLowerCase().includes(String(op.routine_name || op.title).toLowerCase()))
              );
              if (targetRoutine) {
                await triggerRoutineOrHabit(
                  targetRoutine.id,
                  targetRoutine.routine_type === 'recurring_habit'
                    ? 'toggle_habit'
                    : 'queue_sequence',
                  currentBucket
                );
                appliedActions.push(`Triggered Routine: ${targetRoutine.name}`);
              }
            }
          }
        }
      } else {
        const errMsg = `Gemini API error (${lastErrorStatus || 'network'}): ${lastErrorMessage || 'Could not reach Gemini API'}. Check your Gemini API key in Settings.`;
        assistantReply = errMsg;
        uiEffects.errorBanner = errMsg;
      }
    } catch (err: any) {
      const errMsg = `Gemini request failed: ${err?.message || 'Unknown error'}. Check your network or API key in Settings.`;
      assistantReply = errMsg;
      uiEffects.errorBanner = errMsg;
    }
  } else {
    // Strict deterministic command fallback for basic offline commands when no Gemini key is set
    const lower = userMessage.toLowerCase().trim();

    if (/^(pause|pause timer|stop timer)$/.test(lower)) {
      await controlTimer({ command: 'pause' });
      uiEffects.timerCommand = 'pause';
      appliedActions.push('Paused active timer');
      assistantReply = 'Timer paused.';
    } else if (/^(resume|resume timer|start timer|continue)$/.test(lower)) {
      await controlTimer({ command: 'resume' });
      uiEffects.timerCommand = 'resume';
      appliedActions.push('Resumed active timer');
      assistantReply = 'Timer resumed.';
    } else if (/^(done|complete|finish|complete action)$/.test(lower) && activeAction) {
      const prevTitle = activeAction.title;
      await completeAction({
        action_id: activeAction.id,
        actual_minutes: activeAction.estimated_minutes,
        dayBucket: currentBucket,
      });
      appliedActions.push(`Completed: ${prevTitle}`);
      assistantReply = `Completed "${prevTitle}".`;
    } else if (/^(clear queue|empty queue|reset queue)$/.test(lower)) {
      await clearActionQueue();
      appliedActions.push('Cleared Today Queue -> Backlog');
      assistantReply = 'Cleared your Today Queue back to the backlog.';
    } else if (/^(light mode|theme light)$/.test(lower)) {
      uiEffects.theme = 'light';
      appliedActions.push('Theme -> Light Frosted Glass');
      assistantReply = 'Switched to Light Mode.';
    } else if (/^(dark mode|theme dark)$/.test(lower)) {
      uiEffects.theme = 'dark';
      appliedActions.push('Theme -> Dark Frosted Glass');
      assistantReply = 'Switched to Dark Mode.';
    } else if (/^(now|focus|view now)$/.test(lower)) {
      uiEffects.switchView = 'now';
      assistantReply = 'Switched to Now / Focus view.';
    } else if (/^(queue|view queue)$/.test(lower)) {
      uiEffects.switchView = 'queue';
      assistantReply = 'Switched to Queue & Day Plan.';
    } else if (/^(syllabus|study log|view syllabus)$/.test(lower)) {
      uiEffects.switchView = 'syllabus';
      assistantReply = 'Switched to Syllabus & Study Log.';
    } else if (/^(routines|habits|view routines)$/.test(lower)) {
      uiEffects.switchView = 'routines';
      assistantReply = 'Switched to Routines view.';
    } else {
      const minsMatch = lower.match(/^(?:i have|window|available)\s+(\d+)\s*(?:m|min|minutes)?$/);
      if (minsMatch) {
        const mins = Math.max(5, Math.min(480, Number(minsMatch[1])));
        await updateUserState({ available_minutes: mins });
        appliedActions.push(`Available Window -> ${mins}m`);
        assistantReply = `Updated your available window to ${mins} minutes.`;
      } else {
        assistantReply =
          'No Gemini API key is configured yet. Click "Gemini Key" (bottom left) and paste your Google Gemini API key to enable full natural-language and voice Co-Pilot control.';
        uiEffects.errorBanner = assistantReply;
      }
    }
  }

  const snapshotAfterChanges = appliedActions.length > 0 ? preTurnSnapshot : null;
  const formattedAppliedOps = appliedActions.map((summary) => ({
    type: 'copilot_op',
    summary,
  }));

  await execSql(`
    INSERT INTO chat_messages (
      role, content, applied_operations, proposed_actions, undo_snapshot_json
    ) VALUES (
      'assistant',
      ${sqlLiteral(assistantReply)},
      ${sqlLiteral(JSON.stringify(formattedAppliedOps))}::jsonb,
      ${sqlLiteral(JSON.stringify(proposedActions))}::jsonb,
      ${snapshotAfterChanges ? sqlLiteral(snapshotAfterChanges) : 'NULL'}
    );
  `);
  const insertedRows = await queryJson<Array<{ id: number }>>(`SELECT MAX(id) AS id FROM chat_messages`);

  if (insertedRows[0]?.id) {
    uiEffects.lastMessageId = insertedRows[0].id;
  }
  if (!uiEffects.spokenSummary) {
    uiEffects.spokenSummary = assistantReply;
  }

  return {
    reply: assistantReply,
    appliedActions,
    proposedActions,
    uiEffects,
  };
}
