import { execSql, getFullWorkspaceData, queryJson, sqlLiteral } from '../db/index.ts';
import type {
  ActionRecord,
  ChatMessageRecord,
  RoutineRecord,
  StudyMode,
  TimeOfDayWindow,
  UserStateRecord,
} from '../db/schema.ts';
import { formatStudyMode, getTimeOfDayBucket } from './ai-engine.ts';

export async function captureFullUndoSnapshot(): Promise<string> {
  const userStateRows = await queryJson<any[]>('SELECT * FROM user_state WHERE id = 1 LIMIT 1');
  const rawMemories = await queryJson<any[]>('SELECT * FROM second_brain_memories ORDER BY id ASC');
  const rawSubjects = await queryJson<any[]>('SELECT * FROM study_subjects ORDER BY id ASC');
  const rawTopics = await queryJson<any[]>('SELECT * FROM subject_topics ORDER BY id ASC');
  const rawActions = await queryJson<any[]>('SELECT * FROM actions ORDER BY id ASC');
  const rawLogs = await queryJson<any[]>('SELECT * FROM study_logs ORDER BY id ASC');
  const rawRoutines = await queryJson<any[]>('SELECT * FROM routines ORDER BY id ASC');
  const rawHistory = await queryJson<any[]>('SELECT * FROM action_history ORDER BY id ASC');

  return JSON.stringify({
    userState: userStateRows[0],
    memories: rawMemories,
    subjects: rawSubjects,
    topics: rawTopics,
    actions: rawActions,
    studyLogs: rawLogs,
    routines: rawRoutines,
    history: rawHistory,
  });
}

export async function restoreFullUndoSnapshot(snapshotJson: string): Promise<void> {
  const snap = JSON.parse(snapshotJson);

  await execSql(`
    DELETE FROM action_history;
    DELETE FROM study_logs;
    DELETE FROM actions;
    DELETE FROM subject_topics;
    DELETE FROM study_subjects;
    DELETE FROM routines;
    DELETE FROM second_brain_memories;
  `);

  if (Array.isArray(snap.memories)) {
    for (const m of snap.memories) {
      await execSql(`
        INSERT INTO second_brain_memories (id, category, content, created_at)
        VALUES (
          ${sqlLiteral(m.id)},
          ${sqlLiteral(m.category || 'insight')},
          ${sqlLiteral(m.content || '')},
          ${sqlLiteral(m.created_at || new Date().toISOString())}
        );
      `);
    }
    await execSql(
      `SELECT setval('second_brain_memories_id_seq', COALESCE((SELECT MAX(id) FROM second_brain_memories), 1));`
    );
  }

  if (Array.isArray(snap.subjects)) {
    for (const s of snap.subjects) {
      await execSql(`
        INSERT INTO study_subjects (id, name, code_or_area, priority, current_focus_notes, exam_or_target_date, created_at)
        VALUES (
          ${sqlLiteral(s.id)},
          ${sqlLiteral(s.name)},
          ${sqlLiteral(s.code_or_area || '')},
          ${sqlLiteral(s.priority || 'high')},
          ${sqlLiteral(s.current_focus_notes || '')},
          ${sqlLiteral(s.exam_or_target_date ?? null)},
          ${sqlLiteral(s.created_at || new Date().toISOString())}
        );
      `);
    }
    await execSql(
      `SELECT setval('study_subjects_id_seq', COALESCE((SELECT MAX(id) FROM study_subjects), 1));`
    );
  }

  if (Array.isArray(snap.topics)) {
    for (const t of snap.topics) {
      await execSql(`
        INSERT INTO subject_topics (id, subject_id, title, status, notes, updated_at)
        VALUES (
          ${sqlLiteral(t.id)},
          ${sqlLiteral(t.subject_id)},
          ${sqlLiteral(t.title)},
          ${sqlLiteral(t.status || 'untouched')},
          ${sqlLiteral(t.notes || '')},
          ${sqlLiteral(t.updated_at || new Date().toISOString())}
        );
      `);
    }
    await execSql(
      `SELECT setval('subject_topics_id_seq', COALESCE((SELECT MAX(id) FROM subject_topics), 1));`
    );
  }

  if (Array.isArray(snap.actions)) {
    for (const a of snap.actions) {
      await execSql(`
        INSERT INTO actions (id, title, notes, substeps, category, estimated_minutes, time_of_day_preference, status, queue_order, study_subject_id, study_mode, created_at, completed_at)
        VALUES (
          ${sqlLiteral(a.id)},
          ${sqlLiteral(a.title)},
          ${sqlLiteral(a.notes || '')},
          ${sqlLiteral(JSON.stringify(a.substeps || []))}::jsonb,
          ${sqlLiteral(a.category || 'study')},
          ${sqlLiteral(a.estimated_minutes || 30)},
          ${sqlLiteral(a.time_of_day_preference || 'anytime')},
          ${sqlLiteral(a.status || 'backlog')},
          ${sqlLiteral(a.queue_order || 50)},
          ${sqlLiteral(a.study_subject_id ?? null)},
          ${sqlLiteral(a.study_mode ?? null)},
          ${sqlLiteral(a.created_at || new Date().toISOString())},
          ${sqlLiteral(a.completed_at ?? null)}
        );
      `);
    }
    await execSql(`SELECT setval('actions_id_seq', COALESCE((SELECT MAX(id) FROM actions), 1));`);
  }

  if (Array.isArray(snap.studyLogs)) {
    for (const l of snap.studyLogs) {
      await execSql(`
        INSERT INTO study_logs (id, subject_id, study_mode, topic_covered, duration_minutes, perceived_outcome, needs_followup_next, completed_at)
        VALUES (
          ${sqlLiteral(l.id)},
          ${sqlLiteral(l.subject_id ?? null)},
          ${sqlLiteral(l.study_mode || 'practice_paper')},
          ${sqlLiteral(l.topic_covered)},
          ${sqlLiteral(l.duration_minutes || 45)},
          ${sqlLiteral(l.perceived_outcome || '')},
          ${sqlLiteral(l.needs_followup_next || '')},
          ${sqlLiteral(l.completed_at || new Date().toISOString())}
        );
      `);
    }
    await execSql(
      `SELECT setval('study_logs_id_seq', COALESCE((SELECT MAX(id) FROM study_logs), 1));`
    );
  }

  if (Array.isArray(snap.routines)) {
    for (const r of snap.routines) {
      await execSql(`
        INSERT INTO routines (id, name, routine_type, time_of_day_window, estimated_minutes, category, steps_json, completed_today, last_triggered_at)
        VALUES (
          ${sqlLiteral(r.id)},
          ${sqlLiteral(r.name)},
          ${sqlLiteral(r.routine_type || 'block_sequence')},
          ${sqlLiteral(r.time_of_day_window || 'morning')},
          ${sqlLiteral(r.estimated_minutes || 25)},
          ${sqlLiteral(r.category || 'study')},
          ${sqlLiteral(JSON.stringify(r.steps_json || []))}::jsonb,
          ${sqlLiteral(Boolean(r.completed_today))},
          ${sqlLiteral(r.last_triggered_at ?? null)}
        );
      `);
    }
    await execSql(`SELECT setval('routines_id_seq', COALESCE((SELECT MAX(id) FROM routines), 1));`);
  }

  if (Array.isArray(snap.history)) {
    for (const h of snap.history) {
      await execSql(`
        INSERT INTO action_history (id, action_id, title, category, actual_minutes, time_of_day_bucket, context_location, outcome_note, completed_at)
        VALUES (
          ${sqlLiteral(h.id)},
          ${sqlLiteral(h.action_id ?? null)},
          ${sqlLiteral(h.title)},
          ${sqlLiteral(h.category || 'study')},
          ${sqlLiteral(h.actual_minutes || 30)},
          ${sqlLiteral(h.time_of_day_bucket || 'afternoon')},
          ${sqlLiteral(h.context_location || 'home')},
          ${sqlLiteral(h.outcome_note || '')},
          ${sqlLiteral(h.completed_at || new Date().toISOString())}
        );
      `);
    }
    await execSql(
      `SELECT setval('action_history_id_seq', COALESCE((SELECT MAX(id) FROM action_history), 1));`
    );
  }

  if (snap.userState) {
    const u = snap.userState;
    await execSql(`
      UPDATE user_state
      SET available_minutes = ${sqlLiteral(u.available_minutes ?? 60)},
          context_location = ${sqlLiteral(u.context_location ?? 'home')},
          energy_level = ${sqlLiteral(u.energy_level ?? 'medium')},
          focus_note = ${sqlLiteral(u.focus_note ?? '')},
          gemini_model = ${sqlLiteral(u.gemini_model ?? 'gemini-2.5-flash')},
          exam_name = ${sqlLiteral(u.exam_name ?? '')},
          exam_target_date = ${sqlLiteral(u.exam_target_date ?? '')},
          timer_action_id = ${sqlLiteral(u.timer_action_id ?? null)},
          timer_remaining_seconds = ${sqlLiteral(u.timer_remaining_seconds ?? 0)},
          timer_running = ${sqlLiteral(Boolean(u.timer_running))},
          timer_updated_at = NOW(),
          updated_at = NOW()
      WHERE id = 1;
    `);
  }
}

export async function syncActiveTimerInDb() {
  const activeRows = await queryJson<ActionRecord[]>(
    `SELECT * FROM actions WHERE status = 'active' ORDER BY queue_order ASC, id ASC LIMIT 1`
  );
  const stateRows = await queryJson<UserStateRecord[]>(
    'SELECT * FROM user_state WHERE id = 1 LIMIT 1'
  );
  const currentState = stateRows[0];
  const active = activeRows[0];

  if (!active) {
    await execSql(`
      UPDATE user_state
      SET timer_action_id = NULL, timer_remaining_seconds = 0, timer_running = FALSE, timer_updated_at = NOW()
      WHERE id = 1;
    `);
    return;
  }

  if (!currentState || currentState.timer_action_id !== active.id) {
    await execSql(`
      UPDATE user_state
      SET timer_action_id = ${sqlLiteral(active.id)},
          timer_remaining_seconds = ${sqlLiteral((active.estimated_minutes || 30) * 60)},
          timer_running = TRUE,
          timer_updated_at = NOW()
      WHERE id = 1;
    `);
  }
}

export async function controlTimer(payload: {
  command: 'pause' | 'resume' | 'add_minutes' | 'set_minutes';
  minutes?: number;
}) {
  const workspace = await getFullWorkspaceData();
  const st = workspace.userState;
  if (!st) return;

  let nextRemaining = st.timer_remaining_seconds;
  let nextRunning = st.timer_running;

  if (payload.command === 'pause') {
    nextRunning = false;
  } else if (payload.command === 'resume') {
    nextRunning = true;
  } else if (payload.command === 'add_minutes') {
    nextRemaining = Math.max(0, nextRemaining + (Number(payload.minutes) || 5) * 60);
  } else if (payload.command === 'set_minutes') {
    nextRemaining = Math.max(60, (Number(payload.minutes) || 25) * 60);
  }

  await execSql(`
    UPDATE user_state
    SET timer_remaining_seconds = ${sqlLiteral(nextRemaining)},
        timer_running = ${sqlLiteral(nextRunning)},
        timer_updated_at = NOW()
    WHERE id = 1;
  `);
}

export async function updateUserState(payload: {
  available_minutes?: number;
  context_location?: string;
  energy_level?: string;
  focus_note?: string;
  gemini_model?: string;
  exam_name?: string;
  exam_target_date?: string;
}) {
  const current = (await getFullWorkspaceData()).userState;
  const mins = payload.available_minutes ?? current.available_minutes;
  const loc = payload.context_location ?? current.context_location;
  const energy = payload.energy_level ?? current.energy_level;
  const note = payload.focus_note ?? current.focus_note;
  const model = payload.gemini_model ?? current.gemini_model;
  const examName = payload.exam_name ?? current.exam_name ?? '';
  const examDate = payload.exam_target_date ?? current.exam_target_date ?? '';

  await execSql(`
    UPDATE user_state
    SET available_minutes = ${sqlLiteral(mins)},
        context_location = ${sqlLiteral(loc)},
        energy_level = ${sqlLiteral(energy)},
        focus_note = ${sqlLiteral(note)},
        gemini_model = ${sqlLiteral(model)},
        exam_name = ${sqlLiteral(examName)},
        exam_target_date = ${sqlLiteral(examDate)},
        updated_at = NOW()
    WHERE id = 1;
  `);
}

export async function startOrQueueAction(params: {
  action_id?: number;
  title?: string;
  notes?: string;
  category?: string;
  estimated_minutes?: number;
  time_of_day_preference?: string;
  study_subject_id?: number | null;
  study_mode?: StudyMode | null;
  mode: 'start_now' | 'queue' | 'backlog';
  dayBucket?: TimeOfDayWindow;
}) {
  const targetStatus =
    params.mode === 'start_now' ? 'active' : params.mode === 'backlog' ? 'backlog' : 'queued';

  if (params.mode === 'start_now') {
    await execSql(`
      UPDATE actions
      SET status = 'queued', queue_order = 0
      WHERE status = 'active';
    `);
  }

  if (params.action_id) {
    await execSql(`
      UPDATE actions
      SET status = ${sqlLiteral(targetStatus)},
          queue_order = ${params.mode === 'start_now' ? 1 : 50}
      WHERE id = ${sqlLiteral(params.action_id)};
    `);
    await syncActiveTimerInDb();
    return;
  }

  const title = (params.title || '').trim();
  if (!title) return;
  const notes = params.notes || '';
  const category = params.category || 'study';
  const est = Number(params.estimated_minutes) || 30;
  const tod = params.time_of_day_preference || params.dayBucket || getTimeOfDayBucket();
  const subjId = params.study_subject_id ?? null;
  const studyMode = params.study_mode ?? null;

  await execSql(`
    INSERT INTO actions (title, notes, substeps, category, estimated_minutes, time_of_day_preference, status, queue_order, study_subject_id, study_mode)
    VALUES (
      ${sqlLiteral(title)},
      ${sqlLiteral(notes)},
      '[]'::jsonb,
      ${sqlLiteral(category)},
      ${sqlLiteral(est)},
      ${sqlLiteral(tod)},
      ${sqlLiteral(targetStatus)},
      ${params.mode === 'start_now' ? 1 : 50},
      ${sqlLiteral(subjId)},
      ${sqlLiteral(studyMode)}
    );
  `);
  await syncActiveTimerInDb();
}

export async function completeAction(params: {
  action_id?: number;
  actual_minutes?: number;
  topic_covered?: string;
  needs_followup_next?: string;
  skip_study_log?: boolean;
  dayBucket?: TimeOfDayWindow;
}) {
  const query = params.action_id
    ? `SELECT * FROM actions WHERE id = ${sqlLiteral(params.action_id)} LIMIT 1`
    : `SELECT * FROM actions WHERE status = 'active' LIMIT 1`;
  const rows = await queryJson<ActionRecord[]>(query);
  const act = rows[0];
  if (!act) return;

  const state = (await getFullWorkspaceData()).userState;
  const bucket = params.dayBucket || getTimeOfDayBucket();
  const actualMins = Number(params.actual_minutes) || act.estimated_minutes;

  await execSql(`
    UPDATE actions
    SET status = 'completed', completed_at = NOW()
    WHERE id = ${sqlLiteral(act.id)};

    INSERT INTO action_history (action_id, title, category, actual_minutes, time_of_day_bucket, context_location, outcome_note)
    VALUES (
      ${sqlLiteral(act.id)},
      ${sqlLiteral(act.title)},
      ${sqlLiteral(act.category)},
      ${sqlLiteral(actualMins)},
      ${sqlLiteral(bucket)},
      ${sqlLiteral(state.context_location)},
      ${sqlLiteral(params.topic_covered || act.notes || 'Completed')}
    );
  `);

  if (act.category === 'study' && !params.skip_study_log) {
    const mode: StudyMode = act.study_mode || 'active_exploration';
    const covered = (params.topic_covered || act.title).trim();
    const followup = (params.needs_followup_next || '').trim();

    await execSql(`
      INSERT INTO study_logs (subject_id, study_mode, topic_covered, duration_minutes, perceived_outcome, needs_followup_next)
      VALUES (
        ${sqlLiteral(act.study_subject_id)},
        ${sqlLiteral(mode)},
        ${sqlLiteral(covered)},
        ${sqlLiteral(actualMins)},
        ${sqlLiteral(`Completed (${actualMins}m)`)},
        ${sqlLiteral(followup)}
      );
    `);
  }

  const nextQueued = await queryJson<ActionRecord[]>(
    `SELECT id FROM actions WHERE status = 'queued' ORDER BY queue_order ASC, id ASC LIMIT 1`
  );
  if (nextQueued[0]) {
    await execSql(
      `UPDATE actions SET status = 'active', queue_order = 1 WHERE id = ${nextQueued[0].id};`
    );
  }
  await syncActiveTimerInDb();
}

export async function clearActionQueue() {
  await execSql(`UPDATE actions SET status = 'backlog', queue_order = 100 WHERE status = 'queued';`);
}

export async function skipOrRemoveAction(actionId: number) {
  const rows = await queryJson<ActionRecord[]>(
    `SELECT * FROM actions WHERE id = ${sqlLiteral(actionId)} LIMIT 1`
  );
  const act = rows[0];
  if (!act) return;

  await execSql(`
    UPDATE actions
    SET status = 'backlog', queue_order = 100
    WHERE id = ${sqlLiteral(actionId)};
  `);

  if (act.status === 'active') {
    const nextQueued = await queryJson<ActionRecord[]>(
      `SELECT id FROM actions WHERE status = 'queued' ORDER BY queue_order ASC, id ASC LIMIT 1`
    );
    if (nextQueued[0]) {
      await execSql(
        `UPDATE actions SET status = 'active', queue_order = 1 WHERE id = ${nextQueued[0].id};`
      );
    }
  }
  await syncActiveTimerInDb();
}

export async function deleteActionPermanently(actionId: number) {
  await execSql(`DELETE FROM actions WHERE id = ${sqlLiteral(actionId)};`);
  await syncActiveTimerInDb();
}

export async function toggleActionSubstep(actionId: number, substepId: string) {
  const rows = await queryJson<ActionRecord[]>(
    `SELECT * FROM actions WHERE id = ${sqlLiteral(actionId)} LIMIT 1`
  );
  const act = rows[0];
  if (!act) return;

  const updated = (act.substeps || []).map((s) =>
    s.id === substepId ? { ...s, done: !s.done } : s
  );

  await execSql(`
    UPDATE actions
    SET substeps = ${sqlLiteral(JSON.stringify(updated))}::jsonb
    WHERE id = ${sqlLiteral(actionId)};
  `);
}

export async function createRoutine(payload: {
  name: string;
  routine_type: 'block_sequence' | 'recurring_habit';
  time_of_day_window: TimeOfDayWindow;
  estimated_minutes: number;
  category: string;
  steps_json?: Array<{
    title: string;
    category: string;
    estimated_minutes: number;
    study_mode?: string | null;
  }>;
}) {
  const name = (payload.name || '').trim();
  if (!name) return;
  const rType = payload.routine_type || 'recurring_habit';
  const est = Number(payload.estimated_minutes) || 25;
  const steps =
    Array.isArray(payload.steps_json) && payload.steps_json.length > 0
      ? payload.steps_json
      : [{ title: name, category: payload.category || 'study', estimated_minutes: est }];

  await execSql(`
    INSERT INTO routines (name, routine_type, time_of_day_window, estimated_minutes, category, steps_json, completed_today)
    VALUES (
      ${sqlLiteral(name)},
      ${sqlLiteral(rType)},
      ${sqlLiteral(payload.time_of_day_window || 'anytime')},
      ${sqlLiteral(est)},
      ${sqlLiteral(payload.category || 'study')},
      ${sqlLiteral(JSON.stringify(steps))}::jsonb,
      FALSE
    );
  `);
}

export async function deleteRoutine(routineId: number) {
  await execSql(`DELETE FROM routines WHERE id = ${sqlLiteral(routineId)};`);
}

export async function triggerRoutineOrHabit(
  routineId: number,
  mode: 'queue_sequence' | 'toggle_habit',
  dayBucket?: TimeOfDayWindow
) {
  const rows = await queryJson<RoutineRecord[]>(
    `SELECT * FROM routines WHERE id = ${sqlLiteral(routineId)} LIMIT 1`
  );
  const routine = rows[0];
  if (!routine) return;

  if (mode === 'toggle_habit' || routine.routine_type === 'recurring_habit') {
    const nextVal = !routine.completed_today;
    await execSql(`
      UPDATE routines
      SET completed_today = ${sqlLiteral(nextVal)},
          last_triggered_at = NOW()
      WHERE id = ${sqlLiteral(routine.id)};
    `);
    if (nextVal) {
      const state = (await getFullWorkspaceData()).userState;
      await execSql(`
        INSERT INTO action_history (title, category, actual_minutes, time_of_day_bucket, context_location, outcome_note)
        VALUES (
          ${sqlLiteral(routine.name)},
          ${sqlLiteral(routine.category)},
          ${sqlLiteral(routine.estimated_minutes)},
          ${sqlLiteral(dayBucket || getTimeOfDayBucket())},
          ${sqlLiteral(state.context_location)},
          'Recurring habit completed'
        );
      `);
    }
    return;
  }

  const steps = routine.steps_json || [];
  for (let idx = 0; idx < steps.length; idx++) {
    const step = steps[idx];
    await execSql(`
      INSERT INTO actions (title, notes, substeps, category, estimated_minutes, time_of_day_preference, status, queue_order, study_mode)
      VALUES (
        ${sqlLiteral(step.title)},
        ${sqlLiteral(`From routine: ${routine.name}`)},
        '[]'::jsonb,
        ${sqlLiteral(step.category || routine.category)},
        ${sqlLiteral(step.estimated_minutes || 25)},
        ${sqlLiteral(routine.time_of_day_window)},
        'queued',
        ${20 + idx},
        ${sqlLiteral(step.study_mode || null)}
      );
    `);
  }

  const activeRows = await queryJson<ActionRecord[]>(
    `SELECT id FROM actions WHERE status = 'active' LIMIT 1`
  );
  if (activeRows.length === 0) {
    const firstQ = await queryJson<ActionRecord[]>(
      `SELECT id FROM actions WHERE status = 'queued' ORDER BY queue_order ASC, id ASC LIMIT 1`
    );
    if (firstQ[0]) {
      await execSql(
        `UPDATE actions SET status = 'active', queue_order = 1 WHERE id = ${firstQ[0].id};`
      );
    }
  }

  await execSql(`
    UPDATE routines
    SET completed_today = TRUE, last_triggered_at = NOW()
    WHERE id = ${sqlLiteral(routine.id)};
  `);
  await syncActiveTimerInDb();
}

export async function createStudyLogEntry(payload: {
  subject_id: number | null;
  study_mode: StudyMode;
  topic_covered: string;
  duration_minutes: number;
  perceived_outcome: string;
  needs_followup_next: string;
  dayBucket?: TimeOfDayWindow;
}) {
  const state = (await getFullWorkspaceData()).userState;
  const dur = Number(payload.duration_minutes) || 30;
  await execSql(`
    INSERT INTO study_logs (subject_id, study_mode, topic_covered, duration_minutes, perceived_outcome, needs_followup_next)
    VALUES (
      ${sqlLiteral(payload.subject_id)},
      ${sqlLiteral(payload.study_mode)},
      ${sqlLiteral(payload.topic_covered)},
      ${sqlLiteral(dur)},
      ${sqlLiteral(payload.perceived_outcome || '')},
      ${sqlLiteral(payload.needs_followup_next || '')}
    );
    INSERT INTO action_history (title, category, actual_minutes, time_of_day_bucket, context_location, outcome_note)
    VALUES (
      ${sqlLiteral(`${formatStudyMode(payload.study_mode)}: ${payload.topic_covered}`)},
      'study',
      ${sqlLiteral(dur)},
      ${sqlLiteral(payload.dayBucket || getTimeOfDayBucket())},
      ${sqlLiteral(state.context_location)},
      ${sqlLiteral(payload.perceived_outcome || '')}
    );
  `);
}

export async function createStudySubject(payload: {
  name: string;
  code_or_area: string;
  priority: 'high' | 'medium' | 'low';
  current_focus_notes: string;
}) {
  const name = (payload.name || '').trim();
  if (!name) return;
  await execSql(`
    INSERT INTO study_subjects (name, code_or_area, priority, current_focus_notes)
    VALUES (
      ${sqlLiteral(name)},
      ${sqlLiteral(payload.code_or_area || '')},
      ${sqlLiteral(payload.priority || 'high')},
      ${sqlLiteral(payload.current_focus_notes || '')}
    );
  `);
}

export async function updateStudySubject(payload: {
  id: number;
  name: string;
  code_or_area: string;
  priority: 'high' | 'medium' | 'low';
  current_focus_notes: string;
}) {
  await execSql(`
    UPDATE study_subjects
    SET name = ${sqlLiteral(payload.name)},
        code_or_area = ${sqlLiteral(payload.code_or_area || '')},
        priority = ${sqlLiteral(payload.priority || 'high')},
        current_focus_notes = ${sqlLiteral(payload.current_focus_notes || '')}
    WHERE id = ${sqlLiteral(payload.id)};
  `);
}

export async function deleteStudySubject(id: number) {
  await execSql(`DELETE FROM study_subjects WHERE id = ${sqlLiteral(id)};`);
}

export async function createSubjectTopic(payload: {
  subject_id: number;
  title: string;
  status?: string;
  notes?: string;
}) {
  const title = (payload.title || '').trim();
  if (!title) return;
  await execSql(`
    INSERT INTO subject_topics (subject_id, title, status, notes)
    VALUES (
      ${sqlLiteral(payload.subject_id)},
      ${sqlLiteral(title)},
      ${sqlLiteral(payload.status || 'untouched')},
      ${sqlLiteral(payload.notes || '')}
    );
  `);
}

export async function updateSubjectTopicStatus(payload: {
  topic_id: number;
  status: string;
}) {
  await execSql(`
    UPDATE subject_topics
    SET status = ${sqlLiteral(payload.status)},
        updated_at = NOW()
    WHERE id = ${sqlLiteral(payload.topic_id)};
  `);
}

export async function deleteSubjectTopic(topicId: number) {
  await execSql(`DELETE FROM subject_topics WHERE id = ${sqlLiteral(topicId)};`);
}

export async function createMemory(payload: {
  category?: string;
  content: string;
  importance?: number;
}) {
  const cleanContent = String(payload.content || '').trim();
  if (!cleanContent) return;
  const cat = payload.category || 'note';

  // Avoid duplicate identical memory content
  const existing = await queryJson<Array<{ id: number }>>(
    `SELECT id FROM second_brain_memories WHERE LOWER(content) = LOWER(${sqlLiteral(cleanContent)}) LIMIT 1`
  );
  if (existing.length > 0) {
    await execSql(`
      UPDATE second_brain_memories
      SET category = ${sqlLiteral(cat)}
      WHERE id = ${sqlLiteral(existing[0].id)};
    `);
    return;
  }

  await execSql(`
    INSERT INTO second_brain_memories (category, content)
    VALUES (${sqlLiteral(cat)}, ${sqlLiteral(cleanContent)});
  `);
}

export async function deleteMemory(memoryId: number) {
  await execSql(`DELETE FROM second_brain_memories WHERE id = ${sqlLiteral(memoryId)};`);
}

export async function undoChatOperation(messageId?: number) {
  const query = messageId
    ? `SELECT * FROM chat_messages WHERE id = ${sqlLiteral(messageId)} LIMIT 1`
    : `SELECT * FROM chat_messages WHERE undo_snapshot_json IS NOT NULL ORDER BY id DESC LIMIT 1`;
  const rows = await queryJson<ChatMessageRecord[]>(query);
  const msg = rows[0];
  if (!msg || !msg.undo_snapshot_json) return;

  try {
    await restoreFullUndoSnapshot(msg.undo_snapshot_json);
    await execSql(`
      UPDATE chat_messages
      SET applied_operations = '[]'::jsonb,
          undo_snapshot_json = NULL
      WHERE id = ${sqlLiteral(msg.id)};
    `);
  } catch {
    // ignore invalid snapshot
  }
}

