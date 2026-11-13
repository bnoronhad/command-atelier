import { execFileSync } from 'node:child_process';
import type {
  ActionHistoryRecord,
  ActionRecord,
  ChatMessageRecord,
  RoutineRecord,
  StudyLogRecord,
  StudySubjectRecord,
  SubjectTopicRecord,
  UserStateRecord,
} from './schema.ts';

export function getDatabaseUrl(): string {
  return process.env.DATABASE_URL || 'postgresql://antigravity@localhost:5432/command_center';
}

let pgPoolPromise: Promise<any | null> | null = null;
let schemaInitialized = false;

async function getPgPool(): Promise<any | null> {
  if (!pgPoolPromise) {
    pgPoolPromise = (async () => {
      try {
        const mod = await import('pg');
        const Pool = mod.Pool || mod.default?.Pool;
        if (!Pool) return null;
        const dbUrl = getDatabaseUrl();
        const isLocal = dbUrl.includes('localhost') || dbUrl.includes('127.0.0.1');
        return new Pool({
          connectionString: dbUrl,
          ssl: isLocal ? false : { rejectUnauthorized: false },
          max: 5,
        });
      } catch {
        return null;
      }
    })();
  }
  return pgPoolPromise;
}

export async function queryJson<T>(sqlQuery: string): Promise<T> {
  const pool = await getPgPool();
  const wrapped = `SELECT COALESCE(json_agg(t), '[]'::json) AS data FROM (${sqlQuery}) t;`;

  if (pool) {
    const res = await pool.query(wrapped);
    return (res.rows[0]?.data ?? []) as T;
  }

  const out = execFileSync(
    'psql',
    [getDatabaseUrl(), '-X', '-q', '-t', '-A', '-c', wrapped],
    { encoding: 'utf8' }
  ).trim();
  return (out ? JSON.parse(out) : []) as T;
}

export async function execSql(sqlStatement: string): Promise<void> {
  const pool = await getPgPool();
  if (pool) {
    await pool.query(sqlStatement);
    return;
  }
  execFileSync('psql', [getDatabaseUrl(), '-X', '-q', '-c', sqlStatement], {
    encoding: 'utf8',
  });
}

export function sqlLiteral(val: string | number | boolean | null | undefined): string {
  if (val === null || val === undefined) return 'NULL';
  if (typeof val === 'number') return Number.isFinite(val) ? String(val) : '0';
  if (typeof val === 'boolean') return val ? 'TRUE' : 'FALSE';
  return `'${String(val).replace(/'/g, "''")}'`;
}

async function ensureSchemaAndUserState(): Promise<void> {
  if (!schemaInitialized) {
    await execSql(`
      CREATE TABLE IF NOT EXISTS user_state (
        id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
        available_minutes INTEGER NOT NULL DEFAULT 60,
        context_location TEXT NOT NULL DEFAULT 'home',
        energy_level TEXT NOT NULL DEFAULT 'medium',
        focus_note TEXT NOT NULL DEFAULT '',
        ai_mode TEXT NOT NULL DEFAULT 'direct_apply',
        gemini_model TEXT NOT NULL DEFAULT 'gemini-2.5-flash',
        exam_name TEXT NOT NULL DEFAULT '',
        exam_target_date TEXT NOT NULL DEFAULT '',
        last_habit_reset_date TEXT NOT NULL DEFAULT '',
        timer_action_id INTEGER,
        timer_remaining_seconds INTEGER NOT NULL DEFAULT 0,
        timer_running BOOLEAN NOT NULL DEFAULT FALSE,
        timer_updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS study_subjects (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        code_or_area TEXT NOT NULL DEFAULT '',
        priority TEXT NOT NULL DEFAULT 'high',
        current_focus_notes TEXT NOT NULL DEFAULT '',
        exam_or_target_date TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS subject_topics (
        id SERIAL PRIMARY KEY,
        subject_id INTEGER NOT NULL REFERENCES study_subjects(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'untouched',
        notes TEXT NOT NULL DEFAULT '',
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS study_logs (
        id SERIAL PRIMARY KEY,
        subject_id INTEGER REFERENCES study_subjects(id) ON DELETE SET NULL,
        study_mode TEXT NOT NULL DEFAULT 'practice_paper',
        topic_covered TEXT NOT NULL,
        duration_minutes INTEGER NOT NULL DEFAULT 45,
        perceived_outcome TEXT NOT NULL DEFAULT '',
        needs_followup_next TEXT NOT NULL DEFAULT '',
        completed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS actions (
        id SERIAL PRIMARY KEY,
        title TEXT NOT NULL,
        notes TEXT NOT NULL DEFAULT '',
        substeps JSONB NOT NULL DEFAULT '[]'::jsonb,
        category TEXT NOT NULL DEFAULT 'study',
        estimated_minutes INTEGER NOT NULL DEFAULT 30,
        time_of_day_preference TEXT NOT NULL DEFAULT 'anytime',
        status TEXT NOT NULL DEFAULT 'backlog',
        queue_order INTEGER NOT NULL DEFAULT 0,
        study_subject_id INTEGER REFERENCES study_subjects(id) ON DELETE SET NULL,
        study_mode TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        completed_at TIMESTAMPTZ
      );

      CREATE TABLE IF NOT EXISTS routines (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        routine_type TEXT NOT NULL DEFAULT 'block_sequence',
        time_of_day_window TEXT NOT NULL DEFAULT 'morning',
        estimated_minutes INTEGER NOT NULL DEFAULT 25,
        category TEXT NOT NULL DEFAULT 'study',
        steps_json JSONB NOT NULL DEFAULT '[]'::jsonb,
        completed_today BOOLEAN NOT NULL DEFAULT FALSE,
        last_triggered_at TIMESTAMPTZ
      );

      CREATE TABLE IF NOT EXISTS action_history (
        id SERIAL PRIMARY KEY,
        action_id INTEGER REFERENCES actions(id) ON DELETE SET NULL,
        title TEXT NOT NULL,
        category TEXT NOT NULL,
        actual_minutes INTEGER NOT NULL DEFAULT 30,
        time_of_day_bucket TEXT NOT NULL,
        context_location TEXT NOT NULL,
        outcome_note TEXT NOT NULL DEFAULT '',
        completed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS chat_messages (
        id SERIAL PRIMARY KEY,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        applied_operations JSONB NOT NULL DEFAULT '[]'::jsonb,
        proposed_actions JSONB NOT NULL DEFAULT '[]'::jsonb,
        undo_snapshot_json TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    schemaInitialized = true;
  }

  await execSql(`
    INSERT INTO user_state (
      id, available_minutes, context_location, energy_level, focus_note,
      ai_mode, gemini_model, exam_name, exam_target_date, last_habit_reset_date,
      timer_action_id, timer_remaining_seconds, timer_running
    )
    SELECT 1, 60, 'home', 'medium', '', 'direct_apply', 'gemini-2.5-flash', '', '', '', NULL, 0, FALSE
    WHERE NOT EXISTS (SELECT 1 FROM user_state WHERE id = 1);
  `);
}

export async function getFullWorkspaceData(options?: {
  localDate?: string;
  timezone?: string;
}) {
  await ensureSchemaAndUserState();

  const localDate = options?.localDate || new Date().toISOString().slice(0, 10);
  const tz = options?.timezone || 'UTC';

  const stateCheck = await queryJson<UserStateRecord[]>(
    'SELECT * FROM user_state WHERE id = 1 LIMIT 1'
  );
  if (stateCheck[0] && stateCheck[0].last_habit_reset_date !== localDate) {
    await execSql(`
      UPDATE routines SET completed_today = FALSE WHERE routine_type = 'recurring_habit';
      UPDATE user_state SET last_habit_reset_date = ${sqlLiteral(localDate)} WHERE id = 1;
    `);
  }

  const stateRows = await queryJson<UserStateRecord[]>(
    'SELECT * FROM user_state WHERE id = 1 LIMIT 1'
  );
  const userState = stateRows[0];

  if (userState && userState.timer_running && userState.timer_updated_at) {
    const elapsedSec = Math.max(
      0,
      Math.floor((Date.now() - new Date(userState.timer_updated_at).getTime()) / 1000)
    );
    userState.timer_remaining_seconds = Math.max(
      0,
      userState.timer_remaining_seconds - elapsedSec
    );
  }

  const rawSubjects = await queryJson<StudySubjectRecord[]>(`
    SELECT
      ss.*,
      COALESCE((SELECT SUM(sl.duration_minutes)::int FROM study_logs sl WHERE sl.subject_id = ss.id), 0) AS total_minutes,
      COALESCE((SELECT COUNT(sl.id)::int FROM study_logs sl WHERE sl.subject_id = ss.id), 0) AS session_count
    FROM study_subjects ss
    ORDER BY
      CASE ss.priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
      ss.id ASC
  `);

  const allTopics = await queryJson<SubjectTopicRecord[]>(
    'SELECT * FROM subject_topics ORDER BY id ASC'
  );

  const subjects = rawSubjects.map((s) => ({
    ...s,
    topics: allTopics.filter((t) => t.subject_id === s.id),
  }));

  const studyLogs = await queryJson<StudyLogRecord[]>(`
    SELECT sl.*, ss.name AS subject_name
    FROM study_logs sl
    LEFT JOIN study_subjects ss ON sl.subject_id = ss.id
    ORDER BY sl.completed_at DESC
    LIMIT 40
  `);

  const actions = await queryJson<ActionRecord[]>(`
    SELECT * FROM actions
    ORDER BY
      CASE status
        WHEN 'active' THEN 0
        WHEN 'queued' THEN 1
        WHEN 'backlog' THEN 2
        WHEN 'completed' THEN 3
        ELSE 4
      END,
      queue_order ASC,
      id ASC
  `);

  const routines = await queryJson<RoutineRecord[]>('SELECT * FROM routines ORDER BY id ASC');

  const safeTz = /^[A-Za-z0-9_+\-/]+$/.test(tz) ? tz : 'UTC';
  const historyToday = await queryJson<ActionHistoryRecord[]>(`
    SELECT * FROM action_history
    WHERE (completed_at AT TIME ZONE ${sqlLiteral(safeTz)})::date = ${sqlLiteral(localDate)}::date
    ORDER BY completed_at DESC
  `);

  const historyAll = await queryJson<ActionHistoryRecord[]>(
    'SELECT * FROM action_history ORDER BY completed_at DESC LIMIT 40'
  );

  const chatMessages = await queryJson<ChatMessageRecord[]>(
    'SELECT * FROM chat_messages ORDER BY id ASC LIMIT 50'
  );

  return {
    userState,
    subjects,
    studyLogs,
    actions,
    routines,
    history: historyToday,
    historyAll,
    chatMessages,
  };
}
