-- 0001_init.sql: Complete Production PostgreSQL Schema (Zero Placeholders)

CREATE TABLE IF NOT EXISTS user_state (
  id SERIAL PRIMARY KEY,
  available_minutes INTEGER NOT NULL DEFAULT 60,
  context_location VARCHAR(64) NOT NULL DEFAULT 'home',
  energy_level VARCHAR(32) NOT NULL DEFAULT 'medium',
  focus_note TEXT NOT NULL DEFAULT '',
  ai_mode VARCHAR(32) NOT NULL DEFAULT 'direct_apply',
  gemini_model VARCHAR(64) NOT NULL DEFAULT 'gemini-2.5-flash',
  exam_name VARCHAR(160) NOT NULL DEFAULT '',
  exam_target_date VARCHAR(32) NOT NULL DEFAULT '',
  last_habit_reset_date VARCHAR(16) NOT NULL DEFAULT '',
  timer_action_id INTEGER,
  timer_remaining_seconds INTEGER NOT NULL DEFAULT 0,
  timer_running BOOLEAN NOT NULL DEFAULT FALSE,
  timer_updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS study_subjects (
  id SERIAL PRIMARY KEY,
  name VARCHAR(160) NOT NULL,
  code_or_area VARCHAR(80) NOT NULL DEFAULT '',
  priority VARCHAR(32) NOT NULL DEFAULT 'high',
  current_focus_notes TEXT NOT NULL DEFAULT '',
  exam_or_target_date VARCHAR(64),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS subject_topics (
  id SERIAL PRIMARY KEY,
  subject_id INTEGER NOT NULL REFERENCES study_subjects(id) ON DELETE CASCADE,
  title VARCHAR(200) NOT NULL,
  status VARCHAR(48) NOT NULL DEFAULT 'untouched',
  notes TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS study_logs (
  id SERIAL PRIMARY KEY,
  subject_id INTEGER REFERENCES study_subjects(id) ON DELETE SET NULL,
  study_mode VARCHAR(64) NOT NULL DEFAULT 'practice_paper',
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
  category VARCHAR(64) NOT NULL DEFAULT 'study',
  estimated_minutes INTEGER NOT NULL DEFAULT 30,
  time_of_day_preference VARCHAR(32) NOT NULL DEFAULT 'anytime',
  status VARCHAR(32) NOT NULL DEFAULT 'backlog',
  queue_order INTEGER NOT NULL DEFAULT 100,
  study_subject_id INTEGER REFERENCES study_subjects(id) ON DELETE SET NULL,
  study_mode VARCHAR(64),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS routines (
  id SERIAL PRIMARY KEY,
  name VARCHAR(160) NOT NULL,
  routine_type VARCHAR(32) NOT NULL DEFAULT 'block_sequence',
  time_of_day_window VARCHAR(32) NOT NULL DEFAULT 'morning',
  estimated_minutes INTEGER NOT NULL DEFAULT 25,
  category VARCHAR(64) NOT NULL DEFAULT 'study',
  steps_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  completed_today BOOLEAN NOT NULL DEFAULT FALSE,
  last_triggered_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS action_history (
  id SERIAL PRIMARY KEY,
  action_id INTEGER REFERENCES actions(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  category VARCHAR(64) NOT NULL DEFAULT 'study',
  actual_minutes INTEGER NOT NULL DEFAULT 30,
  time_of_day_bucket VARCHAR(32) NOT NULL DEFAULT 'afternoon',
  context_location VARCHAR(64) NOT NULL DEFAULT 'home',
  outcome_note TEXT NOT NULL DEFAULT '',
  completed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS chat_messages (
  id SERIAL PRIMARY KEY,
  role VARCHAR(32) NOT NULL,
  content TEXT NOT NULL,
  applied_operations JSONB NOT NULL DEFAULT '[]'::jsonb,
  proposed_actions JSONB NOT NULL DEFAULT '[]'::jsonb,
  undo_snapshot_json TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO user_state (
  id, available_minutes, context_location, energy_level, focus_note,
  ai_mode, gemini_model, exam_name, exam_target_date, last_habit_reset_date,
  timer_action_id, timer_remaining_seconds, timer_running
)
SELECT 1, 60, 'home', 'medium', '', 'direct_apply', 'gemini-2.5-flash', '', '', '', NULL, 0, FALSE
WHERE NOT EXISTS (SELECT 1 FROM user_state WHERE id = 1);
