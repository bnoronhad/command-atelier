/**
 * Production PostgreSQL Schema Types
 * Compatible with Supabase, Neon, and standard PostgreSQL 15+.
 */

export type ContextLocation = 'home' | 'office' | 'library' | 'out' | 'deep-work-ready';
export type TimeOfDayWindow = 'morning' | 'afternoon' | 'evening' | 'night' | 'anytime';
export type ActionCategory = 'study' | 'work' | 'personal' | 'health' | 'admin';
export type ActionStatus = 'backlog' | 'queued' | 'active' | 'completed' | 'skipped';
export type StudyMode =
  | 'practice_paper'
  | 'paper_correction'
  | 'anki_review'
  | 'active_exploration'
  | 'problem_set'
  | 'summary_notes';

export type TopicStatus =
  | 'untouched'
  | 'needs_exploration'
  | 'needs_practice_paper'
  | 'needs_correction'
  | 'solid';

export type MemoryCategory =
  | 'goal'
  | 'preference'
  | 'weak_spot'
  | 'pattern'
  | 'insight'
  | 'note';

export interface SubstepItem {
  id: string;
  text: string;
  done: boolean;
}

export interface UserStateRecord {
  id: number;
  available_minutes: number;
  context_location: ContextLocation;
  energy_level: 'low' | 'medium' | 'high';
  focus_note: string;
  ai_mode: 'direct_apply' | 'propose_only';
  gemini_model: string;
  exam_name: string;
  exam_target_date: string;
  last_habit_reset_date: string;
  timer_action_id: number | null;
  timer_remaining_seconds: number;
  timer_running: boolean;
  timer_updated_at: string;
  updated_at: string;
}

export interface SecondBrainMemoryRecord {
  id: number;
  category: MemoryCategory;
  content: string;
  created_at: string;
}

export interface SubjectTopicRecord {
  id: number;
  subject_id: number;
  title: string;
  status: TopicStatus;
  notes: string;
  updated_at: string;
}

export interface StudySubjectRecord {
  id: number;
  name: string;
  code_or_area: string;
  priority: 'high' | 'medium' | 'low';
  current_focus_notes: string;
  exam_or_target_date: string | null;
  created_at: string;
  total_minutes?: number;
  session_count?: number;
  topics?: SubjectTopicRecord[];
}

export interface StudyLogRecord {
  id: number;
  subject_id: number | null;
  subject_name?: string;
  study_mode: StudyMode;
  topic_covered: string;
  duration_minutes: number;
  perceived_outcome: string;
  needs_followup_next: string;
  completed_at: string;
}

export interface ActionRecord {
  id: number;
  title: string;
  notes: string;
  substeps: SubstepItem[];
  category: ActionCategory;
  estimated_minutes: number;
  time_of_day_preference: TimeOfDayWindow;
  status: ActionStatus;
  queue_order: number;
  study_subject_id: number | null;
  study_mode: StudyMode | null;
  created_at: string;
  completed_at: string | null;
}

export interface RoutineStepTemplate {
  title: string;
  category: ActionCategory;
  estimated_minutes: number;
  study_mode?: StudyMode | null;
  notes?: string;
}

export interface RoutineRecord {
  id: number;
  name: string;
  routine_type: 'block_sequence' | 'recurring_habit';
  time_of_day_window: TimeOfDayWindow;
  estimated_minutes: number;
  category: ActionCategory;
  steps_json: RoutineStepTemplate[];
  completed_today: boolean;
  last_triggered_at: string | null;
}

export interface ActionHistoryRecord {
  id: number;
  action_id: number | null;
  title: string;
  category: ActionCategory;
  actual_minutes: number;
  time_of_day_bucket: TimeOfDayWindow;
  context_location: string;
  outcome_note: string;
  completed_at: string;
}

export interface ProposedActionItem {
  id: string;
  title: string;
  notes: string;
  category: ActionCategory;
  estimated_minutes: number;
  time_of_day_preference: TimeOfDayWindow;
  study_subject_id: number | null;
  study_mode: StudyMode | null;
  reason: string;
  accepted?: boolean;
}

export interface ChatMessageRecord {
  id: number;
  role: 'user' | 'assistant';
  content: string;
  applied_operations: Array<{
    type: string;
    summary: string;
  }>;
  proposed_actions: ProposedActionItem[];
  undo_snapshot_json: string | null;
  created_at: string;
}
