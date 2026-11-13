// Command Atelier — Single-Focus Frosted Glass UI & Server-Side Gemini Voice Co-Pilot Client

let workspace = null;
let activeView = 'now'; // 'now' | 'queue' | 'syllabus' | 'routines'
let syllabusSubView = 'subjects'; // 'subjects' | 'logs'
let studyFilterMode = 'all';
let showStudyDebriefForId = null;
let showMoreRecommendations = false;

// Active execution timer state (synced with server user_state)
let timerRunning = false;
let timerRemainingSec = 0;
let activeTimerActionId = null;

// Voice & Co-Pilot state
let isRecordingVoice = false;
let ttsEnabled = true;
let activeSpeechAudio = null;
let pendingVoiceContextPrefix = '';
let mediaRecorder = null;
let audioChunks = [];
let recordingStartTime = 0;
let recordingTimerInterval = null;
let audioContext = null;
let audioAnalyser = null;
let audioLevelRaf = null;
let lastUndoMessageId = null;

const MEMORY_CATEGORY_LABELS = {
  goal: 'Goal',
  weak_spot: 'Weak Spot',
  preference: 'Preference',
  pattern: 'Study Pattern',
  insight: 'Insight',
  note: 'Note'
};

const STUDY_MODE_LABELS = {
  practice_paper: 'Practice Paper',
  paper_correction: 'Paper Correction',
  anki_review: 'Anki Review',
  active_exploration: 'Active Exploration',
  problem_set: 'Problem Set',
  summary_notes: 'Summary Notes'
};

const TOPIC_STATUS_LABELS = {
  untouched: 'Untouched',
  needs_exploration: 'Needs Exploration',
  needs_practice_paper: 'Needs Practice Paper',
  needs_correction: 'Needs Correction',
  solid: 'Solid'
};

function getSavedApiKey() {
  return localStorage.getItem('cc_gemini_api_key') || '';
}

function setSavedApiKey(key) {
  localStorage.setItem('cc_gemini_api_key', (key || '').trim());
}

function getSavedAccessPassword() {
  return localStorage.getItem('cc_access_password') || '';
}

function setSavedAccessPassword(pw) {
  localStorage.setItem('cc_access_password', (pw || '').trim());
}

function getLocalContextHeaders() {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const localDate = `${yyyy}-${mm}-${dd}`;
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const hr = now.getHours();
  const dayBucket = hr >= 5 && hr < 12 ? 'morning' : hr >= 12 && hr < 17 ? 'afternoon' : hr >= 17 && hr < 22 ? 'evening' : 'night';

  return {
    'x-gemini-api-key': getSavedApiKey(),
    'x-access-password': getSavedAccessPassword(),
    'x-user-local-date': localDate,
    'x-user-timezone': tz,
    'x-user-day-bucket': dayBucket
  };
}

function openModal(id) {
  document.getElementById(id)?.classList.add('open');
}

function closeModal(id) {
  document.getElementById(id)?.classList.remove('open');
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatSec(sec) {
  const safe = Math.max(0, Math.floor(Number(sec) || 0));
  const m = Math.floor(safe / 60);
  const s = Math.floor(safe % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function formatTotalMins(mins) {
  const m = Number(mins) || 0;
  if (m < 60) return `${m}m`;
  const hrs = Math.floor(m / 60);
  const rem = m % 60;
  return rem > 0 ? `${hrs}h ${rem}m` : `${hrs}h`;
}

function showCopilotToast(message, options = {}) {
  const toast = document.getElementById('copilotToast');
  const eyebrow = document.getElementById('copilotToastEyebrow');
  const toastText = document.getElementById('copilotToastText');
  const undoBtn = document.getElementById('copilotUndoBtn');
  if (!toast || !toastText) return;

  if (eyebrow) {
    eyebrow.textContent = options.isError ? 'Diagnostic Notice' : (options.eyebrow || 'Second Brain Executed');
    eyebrow.style.color = options.isError ? 'var(--tone-rose)' : 'var(--tone-emerald)';
  }
  toastText.textContent = message;
  if (undoBtn) {
    undoBtn.style.display = options.canUndo ? 'inline-flex' : 'none';
  }
  toast.classList.add('visible');
}

async function apiFetchWorkspace() {
  const res = await fetch('/api/workspace', {
    headers: getLocalContextHeaders()
  });
  if (res.status === 401) {
    openModal('passwordGateModal');
    return;
  }
  workspace = await res.json();
  syncTimerWithActiveAction();
  renderAll();
}

async function apiMutate(op, payload) {
  const res = await fetch('/api/workspace', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...getLocalContextHeaders()
    },
    body: JSON.stringify({ op, payload })
  });
  if (res.status === 401) {
    openModal('passwordGateModal');
    return;
  }
  workspace = await res.json();
  syncTimerWithActiveAction();
  renderAll();
}

async function apiRequestGeminiDecision() {
  const btn = document.getElementById('refreshDecisionBtn');
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Evaluating...';
  }
  try {
    const res = await fetch('/api/ai/decide', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...getLocalContextHeaders()
      },
      body: JSON.stringify({ apiKey: getSavedApiKey() })
    });
    if (res.status === 401) {
      openModal('passwordGateModal');
      return;
    }
    workspace = await res.json();
    syncTimerWithActiveAction();
    renderAll();
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Re-evaluate';
    }
  }
}

async function apiSendCopilotCommand(messageText, audioBase64 = null, audioMimeType = null, forceSpeak = false) {
  const submitBtn = document.getElementById('copilotSubmitBtn');
  const input = document.getElementById('copilotInputBox');
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.textContent = audioBase64 ? 'Transcribing...' : 'Thinking...';
  }
  if (input && audioBase64) {
    input.placeholder = 'Second Brain is listening, organizing, and executing...';
  }
  try {
    const res = await fetch('/api/ai/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...getLocalContextHeaders()
      },
      body: JSON.stringify({
        message: messageText,
        audioBase64,
        audioMimeType,
        apiKey: getSavedApiKey()
      })
    });
    if (res.status === 401) {
      openModal('passwordGateModal');
      return;
    }
    const data = await res.json();
    workspace = data;
    syncTimerWithActiveAction();

    if (data.lastTurnResult) {
      handleTurnResultEffects(data.lastTurnResult, Boolean(audioBase64) || forceSpeak);
    }
    renderAll();
  } catch (err) {
    showCopilotToast(`Network error communicating with Second Brain: ${err?.message || 'Failed'}`, {
      isError: true
    });
  } finally {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Execute';
    }
    if (input) {
      input.placeholder = 'Speak or type in English or Português to your Second Brain...';
    }
  }
}

function handleTurnResultEffects(turnResult, shouldSpeak = false) {
  const fx = turnResult.uiEffects || {};
  const applied = turnResult.appliedActions || [];
  const reply = turnResult.reply || '';

  if (fx.switchView) {
    activeView = fx.switchView;
  }
  if (fx.syllabusSubtab) {
    syllabusSubView = fx.syllabusSubtab;
  }
  if (fx.theme) {
    document.documentElement.setAttribute('data-theme', fx.theme);
  }

  lastUndoMessageId = fx.lastMessageId || null;

  if (fx.errorBanner) {
    stopActiveSpeechPlayback();
    showCopilotToast(fx.errorBanner, { isError: true, canUndo: false });
    return;
  }

  const summaryLine = applied.length > 0
    ? `${applied.join(' · ')} — ${reply}`
    : reply;
  const eyebrowText = fx.transcribedText
    ? `Heard (${fx.detectedLanguage || 'Auto'}): "${fx.transcribedText}"`
    : (applied.length > 0 ? 'Second Brain Executed On The Fly' : 'Second Brain Reply');
  showCopilotToast(summaryLine, {
    eyebrow: eyebrowText,
    canUndo: applied.length > 0 && Boolean(lastUndoMessageId)
  });

  if (shouldSpeak && ttsEnabled && (fx.spokenAudioBase64 || fx.spokenSummary)) {
    speakConfirmation(fx.spokenSummary || reply, fx.spokenAudioBase64, fx.detectedLanguage || 'pt-BR');
  }
}

function setStopSpeakingButtonVisible(visible) {
  const btn = document.getElementById('stopSpeakingBtn');
  if (btn) {
    btn.style.display = visible ? 'inline-flex' : 'none';
  }
}

function stopActiveSpeechPlayback() {
  if (activeSpeechAudio) {
    try {
      activeSpeechAudio.pause();
      activeSpeechAudio.src = '';
    } catch {}
    activeSpeechAudio = null;
  }
  if ('speechSynthesis' in window) {
    try {
      window.speechSynthesis.cancel();
    } catch {}
  }
  setStopSpeakingButtonVisible(false);
}

function speakConfirmation(text, wavBase64 = null, detectedLang = 'pt-BR') {
  if (!ttsEnabled) return;
  stopActiveSpeechPlayback();

  // 1. Primary: Natural Gemini Server-Synthesized WAV Audio
  if (wavBase64) {
    try {
      const audio = new Audio(`data:audio/wav;base64,${wavBase64}`);
      activeSpeechAudio = audio;
      setStopSpeakingButtonVisible(true);
      audio.onended = () => {
        activeSpeechAudio = null;
        setStopSpeakingButtonVisible(false);
      };
      audio.onerror = () => {
        activeSpeechAudio = null;
        setStopSpeakingButtonVisible(false);
      };
      audio.play().catch(() => {
        activeSpeechAudio = null;
        setStopSpeakingButtonVisible(false);
      });
      return;
    } catch {
      // Fall back to language-matched browser speech below
    }
  }

  // 2. Fallback: Language-Matched Web Speech API (strictly locked to pt-BR or en-US)
  if (!('speechSynthesis' in window) || !text) return;
  try {
    const utter = new SpeechSynthesisUtterance(text);
    const targetLang = detectedLang === 'pt-BR' ? 'pt-BR' : 'en-US';
    const langPrefix = targetLang.slice(0, 2).toLowerCase();
    utter.lang = targetLang;
    utter.rate = 1.02;

    const voices = window.speechSynthesis.getVoices ? window.speechSynthesis.getVoices() : [];
    const matchingVoices = voices.filter(v => (v.lang || '').toLowerCase().startsWith(langPrefix));
    const bestVoice =
      matchingVoices.find(v => /natural|neural|premium|luciana|francisca|antonio|samantha|ava|daniel/i.test(v.name)) ||
      matchingVoices.find(v => v.localService) ||
      matchingVoices[0];

    if (bestVoice) {
      utter.voice = bestVoice;
    }
    setStopSpeakingButtonVisible(true);
    utter.onend = () => setStopSpeakingButtonVisible(false);
    utter.onerror = () => setStopSpeakingButtonVisible(false);
    window.speechSynthesis.speak(utter);
  } catch {
    setStopSpeakingButtonVisible(false);
  }
}

function syncTimerWithActiveAction() {
  if (!workspace?.actions) return;
  const active = workspace.actions.find(a => a.status === 'active');
  const st = workspace.userState;
  if (!active) {
    activeTimerActionId = null;
    timerRemainingSec = 0;
    timerRunning = false;
    return;
  }
  activeTimerActionId = active.id;
  if (st && st.timer_action_id === active.id && typeof st.timer_remaining_seconds === 'number') {
    timerRemainingSec = st.timer_remaining_seconds;
    timerRunning = Boolean(st.timer_running);
  } else {
    timerRemainingSec = (active.estimated_minutes || 30) * 60;
    timerRunning = true;
  }
}

function renderRailAndState() {
  if (!workspace?.userState) return;
  const st = workspace.userState;
  const dec = workspace.decision;
  const queued = (workspace.actions || []).filter(a => a.status === 'queued');

  // Clock & Phase
  const now = new Date();
  const dayStr = now.toLocaleDateString([], { weekday: 'short' }).toUpperCase();
  const hr = now.getHours();
  const phase = hr >= 5 && hr < 12 ? 'MORNING' : hr >= 12 && hr < 17 ? 'AFTERNOON' : hr >= 17 && hr < 22 ? 'EVENING' : 'NIGHT';
  const timeStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const clockEl = document.getElementById('railClockReadout');
  if (clockEl) clockEl.textContent = `${dayStr} · ${timeStr} · ${phase}`;

  // Unified Exam Horizon (Zero fake placeholders)
  const examDaysEl = document.getElementById('railExamDays');
  const examNameEl = document.getElementById('railExamName');
  if (st.exam_name || st.exam_target_date) {
    if (st.exam_target_date) {
      const diffDays = Math.ceil((new Date(st.exam_target_date + 'T09:00:00').getTime() - Date.now()) / (1000 * 60 * 60 * 24));
      examDaysEl.textContent = diffDays >= 0
        ? `${diffDays} DAYS REMAINING · ${st.exam_target_date}`
        : `PAST TARGET · ${st.exam_target_date}`;
    } else {
      examDaysEl.textContent = 'DATE NOT SET';
    }
    examNameEl.textContent = st.exam_name || 'Target Exam';
  } else {
    examDaysEl.textContent = 'EXAM HORIZON UNSET';
    examNameEl.textContent = 'Set Exam Target Date';
  }

  // Navigation active state
  document.querySelectorAll('.nav-item[data-view]').forEach(btn => {
    btn.classList.toggle('active', btn.getAttribute('data-view') === activeView);
  });
  document.getElementById('railQueueCount').textContent = String(queued.length);

  // State summary
  document.getElementById('railStateSummary').textContent = `${st.available_minutes}m · ${st.context_location} · ${st.energy_level}`;

  // Highlight state modal buttons
  document.querySelectorAll('#windowPillsContainer button').forEach(b => {
    b.classList.toggle('btn-gold', Number(b.getAttribute('data-window')) === st.available_minutes);
  });
  document.querySelectorAll('#contextPillsContainer button').forEach(b => {
    b.classList.toggle('btn-gold', b.getAttribute('data-context') === st.context_location);
  });
  document.querySelectorAll('#energyPillsContainer button').forEach(b => {
    b.classList.toggle('btn-gold', b.getAttribute('data-energy') === st.energy_level);
  });

  // Gemini status
  const hasKey = Boolean(getSavedApiKey()) || Boolean(workspace.serverHasGeminiKey) || dec?.provider === 'gemini';
  const dot = document.getElementById('aiStatusDot');
  const label = document.getElementById('aiProviderLabel');
  if (dot && label) {
    dot.style.background = hasKey ? 'var(--tone-emerald)' : 'var(--tone-amber)';
    label.textContent = hasKey ? 'Gemini Ready' : 'Set Gemini Key';
  }
}

function renderSingleFocusStage() {
  const stage = document.getElementById('singleFocusStage');
  if (!stage || !workspace) return;

  if (activeView === 'now') {
    renderNowFocusView(stage);
  } else if (activeView === 'queue') {
    renderQueueAndPlanView(stage);
  } else if (activeView === 'syllabus') {
    renderSyllabusAndLogView(stage);
  } else {
    renderRoutinesView(stage);
  }
}

// VIEW 1: NOW / FOCUS
function renderNowFocusView(stage) {
  const active = (workspace.actions || []).find(a => a.status === 'active');
  const dec = workspace.decision;
  const recs = dec?.recommendations || [];
  const primaryRec = recs[0];
  const altRecs = recs.slice(1, 3);
  const memories = workspace.memories || [];

  let activeHtml = '';
  if (!active) {
    activeHtml = `
      <div class="glass-panel" style="text-align: center; padding: 3rem 2rem;">
        <div class="view-eyebrow">ACTIVE FOCUS SLOT</div>
        <h2 class="now-task-title" style="margin-top: 0.4rem;">No session currently in progress</h2>
        <p style="color: var(--ink-secondary); max-width: 520px; margin: 0.6rem auto 1.75rem;">
          ${primaryRec
            ? 'Start the recommended next action below, run a Second Brain Morning Briefing, or speak directly to your Co-Pilot.'
            : 'Your workspace is ready. Run a Brain Dump to unload everything on your mind, generate a Morning Briefing, or add an action.'}
        </p>
        <div style="display: flex; justify-content: center; gap: 0.65rem; flex-wrap: wrap;">
          ${primaryRec ? `
            <button class="btn btn-primary btn-lg" id="emptyStartRecommendedBtn">
              Begin "${escapeHtml(primaryRec.title)}" (${primaryRec.estimated_minutes}m)
            </button>
          ` : `
            <button class="btn btn-primary btn-lg" id="emptyBrainDumpBtn">🧠 Brain Dump Capture</button>
            <button class="btn btn-lg" id="emptyCreateActionBtn">+ Add Action</button>
            <button class="btn btn-lg" id="emptyCreateSubjectBtn">+ Add Study Subject</button>
          `}
        </div>
      </div>
    `;
  } else {
    const isShowingDebrief = showStudyDebriefForId === active.id;
    const substeps = active.substeps || [];

    activeHtml = `
      <section class="glass-panel">
        <div style="display: flex; align-items: flex-start; justify-content: space-between; gap: 2rem; flex-wrap: wrap;">
          <div style="flex: 1; min-width: 260px;">
            <div style="display: flex; align-items: center; gap: 0.55rem; margin-bottom: 0.75rem;">
              <span class="badge-minimal badge-emerald">ACTIVE SESSION</span>
              <span class="badge-minimal">${escapeHtml(active.category)}</span>
              ${active.study_mode ? `<span class="badge-minimal badge-gold">${escapeHtml(STUDY_MODE_LABELS[active.study_mode] || active.study_mode)}</span>` : ''}
            </div>
            <h2 class="now-task-title">${escapeHtml(active.title)}</h2>
            ${active.notes ? `<p style="color: var(--ink-secondary); font-size: 0.95rem; margin-top: 0.55rem; max-width: 600px;">${escapeHtml(active.notes)}</p>` : ''}
          </div>

          <div style="text-align: right;">
            <div class="now-timer-readout" id="activeTimerReadout">${formatSec(timerRemainingSec)}</div>
            <div class="mono" style="font-size: 0.72rem; color: var(--ink-muted); margin-top: 0.4rem; text-transform: uppercase; letter-spacing: 0.08em;">
              ${timerRunning ? 'Running' : 'Paused'} · ${active.estimated_minutes}m target
            </div>
          </div>
        </div>

        ${substeps.length > 0 ? `
          <div style="margin-top: 1.75rem; padding-top: 1.25rem; border-top: 1px solid var(--glass-border); display: flex; flex-direction: column; gap: 0.45rem;">
            ${substeps.map(sub => `
              <label style="display: flex; align-items: center; gap: 0.65rem; cursor: pointer; font-size: 0.88rem; color: ${sub.done ? 'var(--ink-muted)' : 'var(--ink-primary)'}; ${sub.done ? 'text-decoration: line-through;' : ''}">
                <input type="checkbox" data-substep-id="${escapeHtml(sub.id)}" ${sub.done ? 'checked' : ''} style="accent-color: var(--accent-gold);" />
                <span>${escapeHtml(sub.text || sub.title || '')}</span>
              </label>
            `).join('')}
          </div>
        ` : ''}

        <div style="margin-top: 2rem; padding-top: 1.25rem; border-top: 1px solid var(--glass-border); display: flex; align-items: center; justify-content: space-between; gap: 0.75rem; flex-wrap: wrap;">
          <div style="display: flex; gap: 0.55rem;">
            <button class="btn btn-primary btn-lg" id="triggerCompleteActiveBtn">
              Complete ${active.category === 'study' ? '&amp; Smart Check-In' : 'Session'}
            </button>
            <button class="btn btn-lg" id="toggleTimerRunBtn">${timerRunning ? 'Pause' : 'Resume'}</button>
            <button class="btn btn-lg" id="addFiveMinsBtn">+5m</button>
          </div>
          <button class="btn btn-ghost" id="moveActiveToBacklogBtn">Defer to Backlog</button>
        </div>

        ${isShowingDebrief ? `
          <div style="margin-top: 1.5rem; padding-top: 1.5rem; border-top: 1px solid var(--glass-border-strong);">
            <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 0.5rem; margin-bottom: 0.85rem;">
              <div class="mono" style="font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.08em; color: var(--accent-gold);">
                Second Brain Session Check-In — Logs Session, Updates Syllabus &amp; Queues Follow-Up
              </div>
              <button type="button" class="btn btn-sm btn-gold" id="debriefVoiceCheckinBtn">
                🎙️ Speak How It Went
              </button>
            </div>
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 0.85rem;">
              <div>
                <label style="font-size: 0.75rem; color: var(--ink-secondary); display: block; margin-bottom: 0.3rem;">Topic Covered</label>
                <input class="input" id="debriefCoveredInput" type="text" value="${escapeHtml(active.title)}" />
              </div>
              <div>
                <label style="font-size: 0.75rem; color: var(--ink-secondary); display: block; margin-bottom: 0.3rem;">How did it go? / Weak spots or next follow-up</label>
                <input class="input" id="debriefFollowupInput" type="text" placeholder="Ex: Acertei 75%, errei questões de prazos — precisa de revisão" />
              </div>
            </div>
            <div style="display: flex; justify-content: flex-end; gap: 0.55rem; margin-top: 0.9rem; flex-wrap: wrap;">
              <button class="btn" id="debriefSkipBtn">Complete Without Logging</button>
              <button class="btn" id="debriefSaveBtn">Quick Save &amp; Complete</button>
              <button class="btn btn-primary" id="debriefAiSmartBtn">✨ Complete + AI Smart Follow-Up</button>
            </div>
          </div>
        ` : ''}
      </section>
    `;
  }

  const secondBrainHubHtml = `
    <section style="margin-top: 1.85rem;">
      <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 0.75rem;">
        <span class="view-eyebrow">SECOND BRAIN EXECUTIVE WORKFLOWS</span>
        <button class="btn btn-sm btn-ghost" id="openMemoryBankBtn">
          🧠 Memory Bank (${memories.length})
        </button>
      </div>
      <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 0.85rem;">
        <div class="glass-panel-subtle" style="display: flex; flex-direction: column; justify-content: space-between; gap: 0.7rem;">
          <div>
            <div class="mono" style="font-size: 0.66rem; color: var(--accent-gold); text-transform: uppercase; letter-spacing: 0.08em;">01 · DAY ARCHITECT</div>
            <div style="font-weight: 600; font-size: 0.95rem; margin-top: 0.2rem;">Morning Briefing</div>
            <p style="font-size: 0.78rem; color: var(--ink-secondary); margin-top: 0.15rem;">Builds and queues your optimal day plan from your window, habits, and syllabus weak spots.</p>
          </div>
          <button class="btn btn-sm btn-gold" id="triggerMorningBriefingBtn" style="align-self: flex-start;">Generate Day Plan</button>
        </div>

        <div class="glass-panel-subtle" style="display: flex; flex-direction: column; justify-content: space-between; gap: 0.7rem;">
          <div>
            <div class="mono" style="font-size: 0.66rem; color: var(--tone-emerald); text-transform: uppercase; letter-spacing: 0.08em;">02 · STREAM CAPTURE</div>
            <div style="font-weight: 600; font-size: 0.95rem; margin-top: 0.2rem;">Brain Dump</div>
            <p style="font-size: 0.78rem; color: var(--ink-secondary); margin-top: 0.15rem;">Speak or paste a messy ramble—sorted into Queue, Backlog, Subjects, and Memory in one shot.</p>
          </div>
          <button class="btn btn-sm" id="triggerBrainDumpCardBtn" style="align-self: flex-start;">Open Brain Dump</button>
        </div>

        <div class="glass-panel-subtle" style="display: flex; flex-direction: column; justify-content: space-between; gap: 0.7rem;">
          <div>
            <div class="mono" style="font-size: 0.66rem; color: var(--ink-secondary); text-transform: uppercase; letter-spacing: 0.08em;">03 · DIAGNOSTIC AUDIT</div>
            <div style="font-weight: 600; font-size: 0.95rem; margin-top: 0.2rem;">Progress &amp; Blind Spots</div>
            <p style="font-size: 0.78rem; color: var(--ink-secondary); margin-top: 0.15rem;">Audits today's completed sessions against your exam horizon, flags blind spots, and queues next steps.</p>
          </div>
          <button class="btn btn-sm" id="triggerEveningReviewBtn" style="align-self: flex-start;">Run Progress Audit</button>
        </div>
      </div>
    </section>
  `;

  const recommendationHtml = primaryRec ? `
    <section style="margin-top: 2rem;">
      <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 0.85rem;">
        <span class="view-eyebrow">NEXT-ACTION ADVISORY · ${escapeHtml((dec?.current_time_of_day || 'now').toUpperCase())}</span>
        <div style="display: flex; gap: 0.5rem;">
          ${altRecs.length > 0 ? `
            <button class="btn btn-sm btn-ghost" id="toggleAltRecsBtn">
              ${showMoreRecommendations ? 'Hide Alternatives' : `View ${altRecs.length} Alternative${altRecs.length > 1 ? 's' : ''}`}
            </button>
          ` : ''}
          <button class="btn btn-sm btn-ghost" id="refreshDecisionBtn">Re-evaluate</button>
        </div>
      </div>

      <div class="glass-panel-subtle" style="display: flex; align-items: center; justify-content: space-between; gap: 1.5rem; flex-wrap: wrap;">
        <div style="flex: 1; min-width: 240px;">
          <div style="display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.35rem;">
            <span class="badge-minimal badge-gold">PRIMARY RECOMMENDATION</span>
            <span class="badge-minimal mono">${primaryRec.estimated_minutes}m</span>
          </div>
          <div style="font-size: 1.15rem; font-weight: 600; color: var(--ink-primary);">${escapeHtml(primaryRec.title)}</div>
          <p style="font-size: 0.85rem; color: var(--ink-secondary); margin-top: 0.25rem;">${escapeHtml(primaryRec.reasoning)}</p>
        </div>
        <div style="display: flex; gap: 0.5rem; flex-shrink: 0;">
          <button class="btn btn-gold" id="primaryStartNowBtn">Start Now</button>
          <button class="btn" id="primaryQueueBtn">Queue Next</button>
        </div>
      </div>

      ${showMoreRecommendations && altRecs.length > 0 ? `
        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 1rem; margin-top: 0.85rem;">
          ${altRecs.map((alt, i) => `
            <div class="glass-panel-subtle" style="display: flex; flex-direction: column; justify-content: space-between; gap: 0.85rem;">
              <div>
                <div style="display: flex; justify-content: space-between; margin-bottom: 0.3rem;">
                  <span class="badge-minimal">${escapeHtml(alt.badge)}</span>
                  <span class="mono" style="font-size: 0.74rem; color: var(--ink-muted);">${alt.estimated_minutes}m</span>
                </div>
                <div style="font-weight: 600; font-size: 0.95rem;">${escapeHtml(alt.title)}</div>
                <p style="font-size: 0.8rem; color: var(--ink-secondary); margin-top: 0.2rem;">${escapeHtml(alt.reasoning)}</p>
              </div>
              <div style="display: flex; gap: 0.45rem;">
                <button class="btn btn-sm" data-alt-idx="${i + 1}" data-alt-mode="start_now">Start Now</button>
                <button class="btn btn-sm btn-ghost" data-alt-idx="${i + 1}" data-alt-mode="queue">Queue</button>
              </div>
            </div>
          `).join('')}
        </div>
      ` : ''}
    </section>
  ` : '';

  stage.innerHTML = `
    <header class="view-header">
      <div>
        <div class="view-eyebrow">01 / EXECUTION FOCUS &amp; SECOND BRAIN</div>
        <h1 class="view-headline">Present Focus</h1>
      </div>
      <div style="display: flex; gap: 0.5rem;">
        <button class="btn" id="nowOpenBrainDumpBtn">🧠 Brain Dump</button>
        <button class="btn btn-primary" id="nowOpenAddActionBtn">+ New Action</button>
      </div>
    </header>
    ${activeHtml}
    ${recommendationHtml}
    ${secondBrainHubHtml}
  `;

  document.getElementById('nowOpenAddActionBtn').onclick = () => openModal('newActionModal');
  document.getElementById('nowOpenBrainDumpBtn').onclick = () => openModal('brainDumpModal');
  document.getElementById('openMemoryBankBtn').onclick = () => {
    renderMemoryBankModal();
    openModal('memoryModal');
  };
  document.getElementById('triggerBrainDumpCardBtn').onclick = () => openModal('brainDumpModal');

  document.getElementById('triggerMorningBriefingBtn').onclick = () => {
    apiSendCopilotCommand(
      '[SECOND_BRAIN_BRIEFING] Build my Second Brain Morning Briefing and Day Plan: analyze my available time window, energy, exam target date, long-term memories, habits, and syllabus weak spots, queue the 2 to 4 highest-leverage actions for today, and brief me.',
      null,
      null,
      true
    );
  };

  document.getElementById('triggerEveningReviewBtn').onclick = () => {
    apiSendCopilotCommand(
      '[SECOND_BRAIN_REVIEW] Run a Second Brain Progress & Blind-Spot Review: audit what I completed today and recently vs. my exam target date and syllabus topics, identify any blind spots or lagging subjects, save a key insight to my Second Brain Memory Bank, and queue the top follow-up priority.',
      null,
      null,
      true
    );
  };

  const emptyStartBtn = document.getElementById('emptyStartRecommendedBtn');
  if (emptyStartBtn && primaryRec) {
    emptyStartBtn.onclick = () => triggerRecommendationChoice(primaryRec, 'start_now');
  }
  const emptyDumpBtn = document.getElementById('emptyBrainDumpBtn');
  if (emptyDumpBtn) emptyDumpBtn.onclick = () => openModal('brainDumpModal');
  const emptyActionBtn = document.getElementById('emptyCreateActionBtn');
  if (emptyActionBtn) emptyActionBtn.onclick = () => openModal('newActionModal');
  const emptySubjBtn = document.getElementById('emptyCreateSubjectBtn');
  if (emptySubjBtn) emptySubjBtn.onclick = () => openSubjectModal();

  if (active) {
    stage.querySelectorAll('input[data-substep-id]').forEach(cb => {
      cb.onchange = () => apiMutate('toggle_substep', {
        action_id: active.id,
        substep_id: cb.getAttribute('data-substep-id')
      });
    });

    document.getElementById('toggleTimerRunBtn').onclick = () => {
      const nextCommand = timerRunning ? 'pause' : 'resume';
      apiMutate('control_timer', { command: nextCommand });
    };
    document.getElementById('addFiveMinsBtn').onclick = () => {
      apiMutate('control_timer', { command: 'add_minutes', minutes: 5 });
    };
    document.getElementById('moveActiveToBacklogBtn').onclick = () => {
      apiMutate('skip_action', { action_id: active.id });
    };
    document.getElementById('triggerCompleteActiveBtn').onclick = () => {
      if (active.category === 'study' && showStudyDebriefForId !== active.id) {
        showStudyDebriefForId = active.id;
        renderSingleFocusStage();
        document.getElementById('debriefFollowupInput')?.focus();
      } else {
        apiMutate('complete_action', {
          action_id: active.id,
          actual_minutes: active.estimated_minutes,
          skip_study_log: active.category !== 'study'
        });
      }
    };

    if (showStudyDebriefForId === active.id) {
      document.getElementById('debriefSkipBtn').onclick = () => {
        showStudyDebriefForId = null;
        apiMutate('complete_action', {
          action_id: active.id,
          actual_minutes: active.estimated_minutes,
          skip_study_log: true
        });
      };
      document.getElementById('debriefSaveBtn').onclick = () => {
        const covered = document.getElementById('debriefCoveredInput').value;
        const followup = document.getElementById('debriefFollowupInput').value;
        showStudyDebriefForId = null;
        apiMutate('complete_action', {
          action_id: active.id,
          actual_minutes: active.estimated_minutes,
          topic_covered: covered,
          needs_followup_next: followup,
          skip_study_log: false
        });
      };
      document.getElementById('debriefAiSmartBtn').onclick = () => {
        const covered = document.getElementById('debriefCoveredInput').value || active.title;
        const followup = document.getElementById('debriefFollowupInput').value || 'Completed session';
        showStudyDebriefForId = null;
        apiSendCopilotCommand(
          `[SECOND_BRAIN_CHECKIN] Complete my active session "${active.title}" (${active.estimated_minutes}m, mode: ${active.study_mode || 'study'}). Topic covered: "${covered}". Outcome / notes: "${followup}". Please complete the active action, log the study session, update the matching syllabus topic status if applicable, save any weak spot or insight to my Second Brain memory, and queue the logical next follow-up session.`,
          null,
          null,
          true
        );
      };
      document.getElementById('debriefVoiceCheckinBtn').onclick = () => {
        pendingVoiceContextPrefix = `[SECOND_BRAIN_CHECKIN] Complete my active session "${active.title}" (${active.estimated_minutes}m) and process my spoken session debrief (log study session, update syllabus topic status, save weak spots to memory, and queue follow-up): `;
        showStudyDebriefForId = null;
        startVoiceRecording();
      };
    }
  }

  if (primaryRec) {
    const altBtn = document.getElementById('toggleAltRecsBtn');
    if (altBtn) {
      altBtn.onclick = () => {
        showMoreRecommendations = !showMoreRecommendations;
        renderSingleFocusStage();
      };
    }
    document.getElementById('refreshDecisionBtn').onclick = () => apiRequestGeminiDecision();
    document.getElementById('primaryStartNowBtn').onclick = () => triggerRecommendationChoice(primaryRec, 'start_now');
    document.getElementById('primaryQueueBtn').onclick = () => triggerRecommendationChoice(primaryRec, 'queue');

    stage.querySelectorAll('button[data-alt-idx]').forEach(btn => {
      btn.onclick = () => {
        const idx = Number(btn.getAttribute('data-alt-idx'));
        const mode = btn.getAttribute('data-alt-mode');
        const rec = recs[idx];
        if (rec) triggerRecommendationChoice(rec, mode);
      };
    });
  }
}

// VIEW 2: QUEUE & DAY PLAN
function renderQueueAndPlanView(stage) {
  const queued = (workspace.actions || []).filter(a => a.status === 'queued');
  const backlog = (workspace.actions || []).filter(a => a.status === 'backlog');
  const history = (workspace.history || []).slice(0, 10);

  stage.innerHTML = `
    <header class="view-header">
      <div>
        <div class="view-eyebrow">02 / SEQUENCE &amp; BACKLOG</div>
        <h1 class="view-headline">Queue &amp; Day Plan</h1>
      </div>
      <div style="display: flex; gap: 0.5rem;">
        ${queued.length > 0 ? `<button class="btn btn-ghost" id="clearQueueViewBtn">Clear Queue</button>` : ''}
        <button class="btn btn-primary" id="queueOpenAddBtn">+ New Action</button>
      </div>
    </header>

    <section class="glass-panel" style="margin-bottom: 2rem;">
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem;">
        <span class="view-eyebrow">UP NEXT IN QUEUE (${queued.length})</span>
        <span class="mono" style="font-size: 0.74rem; color: var(--ink-muted);">
          Total queued: ${formatTotalMins(queued.reduce((acc, q) => acc + (q.estimated_minutes || 0), 0))}
        </span>
      </div>

      ${queued.length === 0 ? `
        <p style="color: var(--ink-muted); padding: 1rem 0;">Your queue is empty. Add an action above, promote items from your backlog, or instruct your Co-Pilot.</p>
      ` : `
        <div class="hairline-list">
          ${queued.map((item, idx) => `
            <div class="hairline-row">
              <div style="min-width: 0; flex: 1;">
                <div style="display: flex; align-items: center; gap: 0.65rem;">
                  <span class="mono" style="font-size: 0.74rem; color: var(--ink-muted);">0${idx + 1}</span>
                  <span style="font-size: 0.96rem; font-weight: 600; color: var(--ink-primary);">${escapeHtml(item.title)}</span>
                  ${item.study_mode ? `<span class="badge-minimal badge-gold">${escapeHtml(STUDY_MODE_LABELS[item.study_mode] || item.study_mode)}</span>` : `<span class="badge-minimal">${escapeHtml(item.category)}</span>`}
                </div>
                ${item.notes ? `<p style="font-size: 0.82rem; color: var(--ink-secondary); margin: 0.2rem 0 0 1.85rem;">${escapeHtml(item.notes)}</p>` : ''}
              </div>
              <div style="display: flex; align-items: center; gap: 0.65rem; flex-shrink: 0;">
                <span class="mono" style="font-size: 0.78rem; color: var(--ink-secondary);">${item.estimated_minutes}m</span>
                <button class="btn btn-sm btn-gold" data-start-id="${item.id}">Start Now</button>
                <button class="btn btn-sm btn-ghost" data-remove-id="${item.id}">Defer</button>
              </div>
            </div>
          `).join('')}
        </div>
      `}
    </section>

    <div style="display: grid; grid-template-columns: 1.15fr 0.85fr; gap: 1.75rem;">
      <section class="glass-panel-subtle">
        <div class="view-eyebrow" style="margin-bottom: 0.85rem;">BACKLOG (${backlog.length})</div>
        ${backlog.length === 0 ? `<p style="color: var(--ink-muted); font-size: 0.84rem;">No unqueued tasks in backlog.</p>` : `
          <div class="hairline-list">
            ${backlog.map(b => `
              <div class="hairline-row" style="padding: 0.75rem 0;">
                <div>
                  <div style="font-weight: 500; font-size: 0.88rem;">${escapeHtml(b.title)}</div>
                  <div class="mono" style="font-size: 0.7rem; color: var(--ink-muted); margin-top: 0.15rem;">${b.estimated_minutes}m · ${escapeHtml(b.time_of_day_preference)}</div>
                </div>
                <div style="display: flex; gap: 0.35rem;">
                  <button class="btn btn-sm" data-backlog-q="${b.id}">Queue</button>
                  <button class="btn btn-sm btn-ghost" data-backlog-now="${b.id}">Start</button>
                  <button class="btn btn-sm btn-ghost" data-backlog-del="${b.id}" title="Delete permanently">✕</button>
                </div>
              </div>
            `).join('')}
          </div>
        `}
      </section>

      <section class="glass-panel-subtle">
        <div class="view-eyebrow" style="margin-bottom: 0.85rem;">COMPLETED TODAY (${history.length})</div>
        ${history.length === 0 ? `<p style="color: var(--ink-muted); font-size: 0.84rem;">No completed actions yet today.</p>` : `
          <div class="hairline-list">
            ${history.map(h => `
              <div class="hairline-row" style="padding: 0.7rem 0;">
                <div>
                  <div style="font-size: 0.84rem; color: var(--ink-secondary);">${escapeHtml(h.title)}</div>
                  <div class="mono" style="font-size: 0.68rem; color: var(--ink-muted);">${escapeHtml(h.time_of_day_bucket)} · ${escapeHtml(h.context_location)}</div>
                </div>
                <span class="mono" style="font-size: 0.74rem; color: var(--tone-emerald);">${h.actual_minutes}m</span>
              </div>
            `).join('')}
          </div>
        `}
      </section>
    </div>
  `;

  document.getElementById('queueOpenAddBtn').onclick = () => openModal('newActionModal');
  const clearBtn = document.getElementById('clearQueueViewBtn');
  if (clearBtn) {
    clearBtn.onclick = () => apiMutate('clear_queue', {});
  }

  stage.querySelectorAll('button[data-start-id]').forEach(btn => {
    btn.onclick = () => {
      activeView = 'now';
      apiMutate('start_or_queue_action', {
        action_id: Number(btn.getAttribute('data-start-id')),
        mode: 'start_now'
      });
    };
  });
  stage.querySelectorAll('button[data-remove-id]').forEach(btn => {
    btn.onclick = () => apiMutate('skip_action', {
      action_id: Number(btn.getAttribute('data-remove-id'))
    });
  });
  stage.querySelectorAll('button[data-backlog-q]').forEach(btn => {
    btn.onclick = () => apiMutate('start_or_queue_action', {
      action_id: Number(btn.getAttribute('data-backlog-q')),
      mode: 'queue'
    });
  });
  stage.querySelectorAll('button[data-backlog-now]').forEach(btn => {
    btn.onclick = () => {
      activeView = 'now';
      apiMutate('start_or_queue_action', {
        action_id: Number(btn.getAttribute('data-backlog-now')),
        mode: 'start_now'
      });
    };
  });
  stage.querySelectorAll('button[data-backlog-del]').forEach(btn => {
    btn.onclick = () => apiMutate('delete_action', {
      action_id: Number(btn.getAttribute('data-backlog-del'))
    });
  });
}

// VIEW 3: SYLLABUS & STUDY LOG
function renderSyllabusAndLogView(stage) {
  const subjects = workspace.subjects || [];
  const logs = (workspace.studyLogs || []).filter(
    l => studyFilterMode === 'all' || l.study_mode === studyFilterMode
  );

  stage.innerHTML = `
    <header class="view-header">
      <div>
        <div class="view-eyebrow">03 / EXAM PREPARATION ARCHITECTURE</div>
        <h1 class="view-headline">Syllabus &amp; Study Log</h1>
      </div>
      <div style="display: flex; gap: 0.5rem;">
        <button class="btn ${syllabusSubView === 'subjects' ? 'btn-gold' : ''}" id="subBtnSubjects">Subjects (${subjects.length})</button>
        <button class="btn ${syllabusSubView === 'logs' ? 'btn-gold' : ''}" id="subBtnLogs">Session Log (${(workspace.studyLogs || []).length})</button>
        ${syllabusSubView === 'subjects'
          ? `<button class="btn btn-primary" id="openAddSubjectBtn">+ Subject</button>`
          : `<button class="btn btn-primary" id="openLogStudyBtn">+ Log Session</button>`}
      </div>
    </header>

    <div id="syllabusSubStage"></div>
  `;

  document.getElementById('subBtnSubjects').onclick = () => {
    syllabusSubView = 'subjects';
    renderSyllabusAndLogView(stage);
  };
  document.getElementById('subBtnLogs').onclick = () => {
    syllabusSubView = 'logs';
    renderSyllabusAndLogView(stage);
  };

  const addSubjBtn = document.getElementById('openAddSubjectBtn');
  if (addSubjBtn) addSubjBtn.onclick = () => openSubjectModal();

  const logStudyBtn = document.getElementById('openLogStudyBtn');
  if (logStudyBtn) logStudyBtn.onclick = () => openLogStudyModal();

  const subStage = document.getElementById('syllabusSubStage');

  if (syllabusSubView === 'subjects') {
    if (subjects.length === 0) {
      subStage.innerHTML = `
        <section class="glass-panel" style="text-align: center; padding: 3rem 2rem;">
          <div class="view-eyebrow">NO SUBJECTS YET</div>
          <h2 class="serif-display" style="font-size: 1.7rem; margin-top: 0.35rem;">Build Your Exam Syllabus</h2>
          <p style="color: var(--ink-secondary); max-width: 460px; margin: 0.55rem auto 1.5rem;">
            Add your exam subjects and break them into topics or weak areas so the decision engine can schedule practice papers, corrections, and Anki reviews.
          </p>
          <button class="btn btn-primary btn-lg" id="emptyAddFirstSubjBtn">+ Add First Subject</button>
        </section>
      `;
      document.getElementById('emptyAddFirstSubjBtn').onclick = () => openSubjectModal();
      return;
    }

    subStage.innerHTML = `
      <div style="display: flex; flex-direction: column; gap: 1.5rem;">
        ${subjects.map(s => {
          const topics = s.topics || [];
          return `
            <section class="glass-panel">
              <div style="display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; flex-wrap: wrap; margin-bottom: 1.25rem;">
                <div>
                  <div style="display: flex; align-items: center; gap: 0.55rem;">
                    ${s.code_or_area ? `<span class="badge-minimal badge-gold">${escapeHtml(s.code_or_area)}</span>` : ''}
                    <span class="badge-minimal">${escapeHtml(s.priority)} priority</span>
                    <span class="badge-minimal badge-emerald">${formatTotalMins(s.total_minutes)} studied · ${s.session_count || 0} sessions</span>
                  </div>
                  <h2 class="serif-display" style="font-size: 1.75rem; margin-top: 0.35rem;">${escapeHtml(s.name)}</h2>
                  ${s.current_focus_notes ? `<p style="font-size: 0.86rem; color: var(--ink-secondary); margin-top: 0.15rem;">${escapeHtml(s.current_focus_notes)}</p>` : ''}
                </div>

                <div style="display: flex; align-items: center; gap: 0.4rem; flex-wrap: wrap;">
                  <button class="btn btn-sm" data-subj-q="${s.id}" data-subj-name="${escapeHtml(s.name)}" data-mode="practice_paper">+ Practice Paper</button>
                  <button class="btn btn-sm" data-subj-q="${s.id}" data-subj-name="${escapeHtml(s.name)}" data-mode="paper_correction">+ Paper Correction</button>
                  <button class="btn btn-sm" data-subj-q="${s.id}" data-subj-name="${escapeHtml(s.name)}" data-mode="anki_review">+ Anki</button>
                  <button class="btn btn-sm btn-ghost" data-edit-subj="${s.id}">Edit</button>
                  <button class="btn btn-sm btn-ghost" data-del-subj="${s.id}">Delete</button>
                </div>
              </div>

              ${topics.length === 0 ? `
                <p style="font-size: 0.84rem; color: var(--ink-muted); padding: 0.4rem 0 0.8rem;">No topics added to this subject yet.</p>
              ` : `
                <div class="hairline-list">
                  ${topics.map(t => `
                    <div class="hairline-row" style="padding: 0.7rem 0.2rem;">
                      <span style="font-size: 0.9rem; font-weight: 500; flex: 1;">${escapeHtml(t.title)}</span>
                      <div style="display: flex; align-items: center; gap: 0.5rem;">
                        <select class="status-select-clean status-${escapeHtml(t.status)}" data-topic-status-id="${t.id}">
                          ${Object.entries(TOPIC_STATUS_LABELS).map(([k, lbl]) => `
                            <option value="${k}" ${t.status === k ? 'selected' : ''}>${escapeHtml(lbl)}</option>
                          `).join('')}
                        </select>
                        <button class="btn btn-sm" data-topic-queue="${t.id}" data-topic-title="${escapeHtml(t.title)}" data-topic-subj="${s.id}" data-topic-status="${t.status}">Queue Session</button>
                        <button class="btn btn-sm btn-ghost" data-del-topic="${t.id}">✕</button>
                      </div>
                    </div>
                  `).join('')}
                </div>
              `}

              <form class="add-topic-form" data-subj-id="${s.id}" style="display: flex; gap: 0.5rem; margin-top: 1rem;">
                <input class="input" type="text" name="topicTitle" placeholder="Add topic or weak area to ${escapeHtml(s.name)}..." required style="flex: 1;" />
                <select class="select" name="topicStatus" style="width: 190px;">
                  <option value="needs_practice_paper">Needs Practice Paper</option>
                  <option value="needs_correction">Needs Correction</option>
                  <option value="needs_exploration">Needs Exploration</option>
                  <option value="untouched">Untouched</option>
                  <option value="solid">Solid</option>
                </select>
                <button type="submit" class="btn">Add Topic</button>
              </form>
            </section>
          `;
        }).join('')}
      </div>
    `;

    subStage.querySelectorAll('button[data-subj-q]').forEach(btn => {
      btn.onclick = () => {
        const subjId = Number(btn.getAttribute('data-subj-q'));
        const subjName = btn.getAttribute('data-subj-name');
        const mode = btn.getAttribute('data-mode');
        const modeLabel = STUDY_MODE_LABELS[mode] || mode;
        apiMutate('start_or_queue_action', {
          title: `${modeLabel}: ${subjName}`,
          notes: 'Queued from Syllabus Manager',
          category: 'study',
          estimated_minutes: mode === 'anki_review' ? 20 : mode === 'paper_correction' ? 35 : 45,
          study_subject_id: subjId,
          study_mode: mode,
          mode: 'queue'
        });
      };
    });

    subStage.querySelectorAll('select[data-topic-status-id]').forEach(sel => {
      sel.onchange = () => apiMutate('update_topic_status', {
        topic_id: Number(sel.getAttribute('data-topic-status-id')),
        status: sel.value
      });
    });

    subStage.querySelectorAll('button[data-topic-queue]').forEach(btn => {
      btn.onclick = () => {
        const title = btn.getAttribute('data-topic-title');
        const subjId = Number(btn.getAttribute('data-topic-subj'));
        const status = btn.getAttribute('data-topic-status');
        const mode = status === 'needs_correction'
          ? 'paper_correction'
          : status === 'needs_practice_paper'
            ? 'practice_paper'
            : status === 'solid'
              ? 'anki_review'
              : 'active_exploration';
        const modeLabel = STUDY_MODE_LABELS[mode] || mode;
        apiMutate('start_or_queue_action', {
          title: `${modeLabel}: ${title}`,
          notes: 'Targeted syllabus weak-area session',
          category: 'study',
          estimated_minutes: mode === 'anki_review' ? 20 : mode === 'paper_correction' ? 30 : 45,
          study_subject_id: subjId,
          study_mode: mode,
          mode: 'queue'
        });
      };
    });

    subStage.querySelectorAll('button[data-del-topic]').forEach(btn => {
      btn.onclick = () => apiMutate('delete_topic', {
        topic_id: Number(btn.getAttribute('data-del-topic'))
      });
    });

    subStage.querySelectorAll('form.add-topic-form').forEach(form => {
      form.onsubmit = (e) => {
        e.preventDefault();
        const subjId = Number(form.getAttribute('data-subj-id'));
        const titleInput = form.querySelector('input[name="topicTitle"]');
        const statusSel = form.querySelector('select[name="topicStatus"]');
        if (!titleInput.value.trim()) return;
        apiMutate('create_topic', {
          subject_id: subjId,
          title: titleInput.value.trim(),
          status: statusSel.value
        });
      };
    });

    subStage.querySelectorAll('button[data-edit-subj]').forEach(btn => {
      btn.onclick = () => {
        const id = Number(btn.getAttribute('data-edit-subj'));
        const subj = subjects.find(x => x.id === id);
        if (subj) openSubjectModal(subj);
      };
    });

    subStage.querySelectorAll('button[data-del-subj]').forEach(btn => {
      btn.onclick = () => apiMutate('delete_subject', {
        id: Number(btn.getAttribute('data-del-subj'))
      });
    });
  } else {
    // Study Session Log view
    const modes = [
      { id: 'all', label: 'All Modes' },
      { id: 'practice_paper', label: 'Practice Papers' },
      { id: 'paper_correction', label: 'Paper Corrections' },
      { id: 'anki_review', label: 'Anki' },
      { id: 'active_exploration', label: 'Active Exploration' }
    ];

    subStage.innerHTML = `
      <section class="glass-panel">
        <div style="display: flex; gap: 0.45rem; margin-bottom: 1.5rem; flex-wrap: wrap;">
          ${modes.map(m => `
            <button class="btn btn-sm ${studyFilterMode === m.id ? 'btn-gold' : ''}" data-filter-mode="${m.id}">
              ${escapeHtml(m.label)}
            </button>
          `).join('')}
        </div>

        ${logs.length === 0 ? `
          <p style="color: var(--ink-muted); padding: 1rem 0;">No study sessions logged yet.</p>
        ` : `
          <div class="hairline-list">
            ${logs.map(log => `
              <div class="hairline-row" style="align-items: flex-start;">
                <div style="flex: 1;">
                  <div style="display: flex; align-items: center; gap: 0.5rem;">
                    <span class="badge-minimal badge-gold">${escapeHtml(STUDY_MODE_LABELS[log.study_mode] || log.study_mode)}</span>
                    ${log.subject_name ? `<span class="badge-minimal">${escapeHtml(log.subject_name)}</span>` : ''}
                    <span class="mono" style="font-size: 0.74rem; color: var(--ink-muted);">${log.duration_minutes}m</span>
                  </div>
                  <div style="font-size: 0.96rem; font-weight: 600; margin-top: 0.35rem;">${escapeHtml(log.topic_covered)}</div>
                  ${log.needs_followup_next ? `
                    <div style="font-size: 0.82rem; color: var(--accent-gold); margin-top: 0.25rem;">
                      Follow-up noted: ${escapeHtml(log.needs_followup_next)}
                    </div>
                  ` : ''}
                </div>
                ${log.needs_followup_next ? `
                  <button class="btn btn-sm" data-followup-title="${escapeHtml(log.needs_followup_next)}" data-followup-subj="${log.subject_id || ''}" data-followup-mode="${log.study_mode === 'practice_paper' ? 'paper_correction' : 'active_exploration'}">
                    Queue Follow-Up
                  </button>
                ` : ''}
              </div>
            `).join('')}
          </div>
        `}
      </section>
    `;

    subStage.querySelectorAll('button[data-filter-mode]').forEach(btn => {
      btn.onclick = () => {
        studyFilterMode = btn.getAttribute('data-filter-mode');
        renderSyllabusAndLogView(stage);
      };
    });

    subStage.querySelectorAll('button[data-followup-title]').forEach(btn => {
      btn.onclick = () => apiMutate('start_or_queue_action', {
        title: btn.getAttribute('data-followup-title'),
        notes: 'Queued from Study Session Log follow-up',
        category: 'study',
        estimated_minutes: 30,
        study_subject_id: Number(btn.getAttribute('data-followup-subj')) || null,
        study_mode: btn.getAttribute('data-followup-mode'),
        mode: 'queue'
      });
    });
  }
}

// VIEW 4: ROUTINES (Block Sequences & Recurring Standalone Habits)
function renderRoutinesView(stage) {
  const routines = workspace.routines || [];
  const sequences = routines.filter(r => r.routine_type === 'block_sequence');
  const habits = routines.filter(r => r.routine_type === 'recurring_habit');

  stage.innerHTML = `
    <header class="view-header">
      <div>
        <div class="view-eyebrow">04 / PROTOCOLS &amp; CADENCE</div>
        <h1 class="view-headline">Routines &amp; Daily Habits</h1>
      </div>
      <button class="btn btn-primary" id="openNewRoutineModalBtn">+ New Routine / Habit</button>
    </header>

    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 1.75rem;">
      <section class="glass-panel">
        <div class="view-eyebrow" style="margin-bottom: 1rem;">MULTI-STEP BLOCK SEQUENCES (${sequences.length})</div>
        ${sequences.length === 0 ? `
          <p style="color: var(--ink-muted); font-size: 0.85rem;">No multi-step sequences created yet. Click "+ New Routine / Habit" to create one.</p>
        ` : `
          <div style="display: flex; flex-direction: column; gap: 1.25rem;">
            ${sequences.map(seq => `
              <div style="padding-bottom: 1.25rem; border-bottom: 1px solid var(--glass-border);">
                <div style="display: flex; justify-content: space-between; align-items: center;">
                  <h3 style="font-size: 1.05rem; font-weight: 600;">${escapeHtml(seq.name)}</h3>
                  <div style="display: flex; align-items: center; gap: 0.4rem;">
                    <span class="badge-minimal mono">${seq.estimated_minutes}m · ${escapeHtml(seq.time_of_day_window)}</span>
                    <button class="btn btn-sm btn-ghost" data-del-routine="${seq.id}" title="Delete routine">✕</button>
                  </div>
                </div>
                <div style="margin: 0.65rem 0 1rem; display: flex; flex-direction: column; gap: 0.3rem;">
                  ${(seq.steps_json || []).map((st, i) => `
                    <div style="font-size: 0.84rem; color: var(--ink-secondary);">
                      <span class="mono" style="color: var(--ink-muted);">0${i + 1}</span> · ${escapeHtml(st.title)} <span class="mono" style="color: var(--ink-muted);">(${st.estimated_minutes}m)</span>
                    </div>
                  `).join('')}
                </div>
                <button class="btn btn-gold" data-trigger-seq="${seq.id}">Load Sequence Into Queue</button>
              </div>
            `).join('')}
          </div>
        `}
      </section>

      <section class="glass-panel">
        <div class="view-eyebrow" style="margin-bottom: 1rem;">STANDALONE RECURRING HABITS (${habits.length})</div>
        ${habits.length === 0 ? `
          <p style="color: var(--ink-muted); font-size: 0.85rem;">No daily recurring habits created yet. Click "+ New Routine / Habit" to add one.</p>
        ` : `
          <div class="hairline-list">
            ${habits.map(hab => `
              <div class="hairline-row">
                <div>
                  <div style="font-size: 0.95rem; font-weight: 500; ${hab.completed_today ? 'text-decoration: line-through; color: var(--ink-muted);' : ''}">
                    ${escapeHtml(hab.name)}
                  </div>
                  <div class="mono" style="font-size: 0.72rem; color: var(--ink-muted); margin-top: 0.15rem;">
                    ${hab.estimated_minutes}m · ${escapeHtml(hab.time_of_day_window)}
                  </div>
                </div>
                <div style="display: flex; align-items: center; gap: 0.4rem;">
                  <button class="btn btn-sm ${hab.completed_today ? '' : 'btn-primary'}" data-toggle-hab="${hab.id}">
                    ${hab.completed_today ? 'Completed Today' : 'Mark Complete'}
                  </button>
                  <button class="btn btn-sm btn-ghost" data-del-routine="${hab.id}" title="Delete habit">✕</button>
                </div>
              </div>
            `).join('')}
          </div>
        `}
      </section>
    </div>
  `;

  document.getElementById('openNewRoutineModalBtn').onclick = () => openModal('routineModal');

  stage.querySelectorAll('button[data-trigger-seq]').forEach(btn => {
    btn.onclick = () => {
      activeView = 'queue';
      apiMutate('trigger_routine', {
        routine_id: Number(btn.getAttribute('data-trigger-seq')),
        mode: 'queue_sequence'
      });
    };
  });

  stage.querySelectorAll('button[data-toggle-hab]').forEach(btn => {
    btn.onclick = () => apiMutate('trigger_routine', {
      routine_id: Number(btn.getAttribute('data-toggle-hab')),
      mode: 'toggle_habit'
    });
  });

  stage.querySelectorAll('button[data-del-routine]').forEach(btn => {
    btn.onclick = () => apiMutate('delete_routine', {
      routine_id: Number(btn.getAttribute('data-del-routine'))
    });
  });
}

function renderTranscriptSheet() {
  const container = document.getElementById('transcriptListContainer');
  if (!container || !workspace?.chatMessages) return;

  if (workspace.chatMessages.length === 0) {
    container.innerHTML = `<p style="color: var(--ink-muted); font-size: 0.82rem;">No Co-Pilot commands yet. Speak or type an instruction below.</p>`;
    return;
  }

  container.innerHTML = workspace.chatMessages.slice(-20).map(msg => {
    const ops = msg.applied_operations || [];
    return `
      <div style="padding-bottom: 0.65rem; border-bottom: 1px solid var(--glass-border);">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.2rem;">
          <span class="mono" style="font-size: 0.66rem; text-transform: uppercase; letter-spacing: 0.08em; color: ${msg.role === 'user' ? 'var(--accent-gold)' : 'var(--tone-emerald)'};">
            ${msg.role === 'user' ? 'YOU' : 'CO-PILOT'}
          </span>
          ${msg.undo_snapshot_json ? `<button class="btn btn-sm btn-ghost" data-undo-msg="${msg.id}">Undo</button>` : ''}
        </div>
        <div style="font-size: 0.84rem; color: var(--ink-primary);">${escapeHtml(msg.content)}</div>
        ${ops.length > 0 ? `
          <div class="mono" style="font-size: 0.7rem; color: var(--tone-emerald); margin-top: 0.3rem;">
            ${ops.map(o => `✓ ${escapeHtml(o.summary || o)}`).join(' · ')}
          </div>
        ` : ''}
      </div>
    `;
  }).join('');

  container.scrollTop = container.scrollHeight;

  container.querySelectorAll('button[data-undo-msg]').forEach(btn => {
    btn.onclick = () => apiMutate('undo_chat_op', {
      message_id: Number(btn.getAttribute('data-undo-msg'))
    });
  });
}

function triggerRecommendationChoice(rec, mode) {
  if (rec.source_type === 'existing_action' && rec.source_id) {
    apiMutate('start_or_queue_action', { action_id: rec.source_id, mode });
  } else {
    apiMutate('start_or_queue_action', {
      title: rec.title,
      notes: rec.reasoning,
      category: rec.category,
      estimated_minutes: rec.estimated_minutes,
      study_mode: rec.study_mode,
      mode
    });
  }
}

function openSubjectModal(subj = null) {
  document.getElementById('subjectModalTitle').textContent = subj ? 'Edit Study Subject' : 'New Study Subject';
  document.getElementById('subjectModalId').value = subj ? String(subj.id) : '';
  document.getElementById('subjectNameInput').value = subj ? subj.name : '';
  document.getElementById('subjectCodeInput').value = subj ? subj.code_or_area : '';
  document.getElementById('subjectPrioritySelect').value = subj ? subj.priority : 'high';
  document.getElementById('subjectNotesInput').value = subj ? subj.current_focus_notes : '';
  openModal('subjectModal');
}

function openLogStudyModal() {
  const subjects = workspace?.subjects || [];
  const sel = document.getElementById('modalLogSubjectSelect');
  if (sel) {
    sel.innerHTML = `<option value="">General Study</option>` + subjects.map(
      s => `<option value="${s.id}">${escapeHtml(s.code_or_area ? `${s.code_or_area} — ${s.name}` : s.name)}</option>`
    ).join('');
  }
  openModal('logStudyModal');
}

// SERVER-SIDE GEMINI VOICE RECORDING ENGINE (MediaRecorder + Web Audio Live Level Meter)
function getSupportedAudioMimeType() {
  if (typeof MediaRecorder === 'undefined') return '';
  const types = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/mp4',
    'audio/ogg;codecs=opus'
  ];
  for (const t of types) {
    if (MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t)) {
      return t;
    }
  }
  return '';
}

function cleanupVoiceAudioGraph() {
  if (recordingTimerInterval) {
    clearInterval(recordingTimerInterval);
    recordingTimerInterval = null;
  }
  if (audioLevelRaf) {
    cancelAnimationFrame(audioLevelRaf);
    audioLevelRaf = null;
  }
  if (audioContext) {
    try { audioContext.close(); } catch {}
    audioContext = null;
    audioAnalyser = null;
  }
  const micBtn = document.getElementById('voiceMicBtn');
  if (micBtn) {
    micBtn.classList.remove('recording');
    micBtn.style.transform = '';
  }
  const badge = document.getElementById('voiceRecordingBadge');
  if (badge) {
    badge.style.display = 'none';
  }
}

async function startVoiceRecording() {
  if (isRecordingVoice) return;

  // Check if Gemini API key is configured before recording
  const hasGeminiKey = Boolean(getSavedApiKey()) || Boolean(workspace?.serverHasGeminiKey);
  if (!hasGeminiKey) {
    showCopilotToast(
      'Voice transcription uses Google Gemini. Paste your Gemini API key in the configuration window to enable voice commands.',
      { isError: true }
    );
    openModal('settingsModalBackdrop');
    return;
  }

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    showCopilotToast(
      'Microphone access is not available in this browser context. Open the app over HTTPS or localhost in a full browser tab.',
      { isError: true }
    );
    return;
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    isRecordingVoice = true;
    audioChunks = [];

    const mimeType = getSupportedAudioMimeType();
    mediaRecorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);

    mediaRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) {
        audioChunks.push(e.data);
      }
    };

    mediaRecorder.start(150);
    recordingStartTime = Date.now();

    const micBtn = document.getElementById('voiceMicBtn');
    const badge = document.getElementById('voiceRecordingBadge');
    const input = document.getElementById('copilotInputBox');

    if (micBtn) micBtn.classList.add('recording');
    if (badge) {
      badge.style.display = 'inline-block';
      badge.textContent = '● REC 00:00';
    }
    if (input) {
      input.placeholder = 'Recording voice... Click Mic again (or release Space) to send to Gemini';
    }

    recordingTimerInterval = setInterval(() => {
      const elapsedSec = Math.floor((Date.now() - recordingStartTime) / 1000);
      if (badge) badge.textContent = `● REC ${formatSec(elapsedSec)}`;
    }, 500);

    // Web Audio live level meter for visual feedback
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (AudioCtx) {
        audioContext = new AudioCtx();
        const source = audioContext.createMediaStreamSource(stream);
        audioAnalyser = audioContext.createAnalyser();
        audioAnalyser.fftSize = 256;
        source.connect(audioAnalyser);
        const dataArray = new Uint8Array(audioAnalyser.frequencyBinCount);

        const updateMeter = () => {
          if (!isRecordingVoice || !audioAnalyser) return;
          audioAnalyser.getByteFrequencyData(dataArray);
          let sum = 0;
          for (let i = 0; i < dataArray.length; i++) sum += dataArray[i];
          const avg = sum / dataArray.length;
          const scale = 1 + Math.min(0.28, avg / 260);
          if (micBtn) micBtn.style.transform = `scale(${scale.toFixed(2)})`;
          audioLevelRaf = requestAnimationFrame(updateMeter);
        };
        updateMeter();
      }
    } catch {
      // ignore Web Audio meter error if unsupported
    }
  } catch (err) {
    isRecordingVoice = false;
    cleanupVoiceAudioGraph();
    const isPermission = err?.name === 'NotAllowedError' || err?.name === 'PermissionDeniedError';
    showCopilotToast(
      isPermission
        ? 'Microphone permission was blocked. Allow microphone access in your browser address bar (or open the app in a full browser tab outside an embedded preview frame).'
        : `Could not start microphone recording: ${err?.message || 'Unknown audio error'}`,
      { isError: true }
    );
  }
}

function stopVoiceRecording(autoSubmit = true) {
  if (!isRecordingVoice) return;
  isRecordingVoice = false;

  const input = document.getElementById('copilotInputBox');
  cleanupVoiceAudioGraph();

  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    const activeRecorder = mediaRecorder;
    activeRecorder.onstop = () => {
      const actualMime = activeRecorder.mimeType || 'audio/webm';
      const blob = new Blob(audioChunks, { type: actualMime });
      activeRecorder.stream?.getTracks().forEach(t => t.stop());

      if (!autoSubmit || blob.size < 200) {
        pendingVoiceContextPrefix = '';
        if (input) input.placeholder = 'Speak or type in English or Português to your Second Brain...';
        return;
      }

      const reader = new FileReader();
      reader.onloadend = () => {
        const resultStr = String(reader.result || '');
        const base64 = resultStr.includes(',') ? resultStr.split(',')[1] : '';
        if (!base64) {
          pendingVoiceContextPrefix = '';
          showCopilotToast('Recorded audio was empty. Try speaking for at least 1 second.', { isError: true });
          return;
        }
        const optionalTypedHint = input?.value.trim() || '';
        const fullPrompt = [pendingVoiceContextPrefix, optionalTypedHint].filter(Boolean).join(' ').trim();
        pendingVoiceContextPrefix = '';
        if (input) input.value = '';
        apiSendCopilotCommand(fullPrompt, base64, actualMime.split(';')[0], true);
      };
      reader.readAsDataURL(blob);
    };
    activeRecorder.stop();
  }
}

function renderMemoryBankModal() {
  const container = document.getElementById('memoryListContainer');
  if (!container) return;
  const memories = workspace?.memories || [];

  if (memories.length === 0) {
    container.innerHTML = `
      <div class="glass-panel-subtle" style="text-align: center; padding: 1.5rem 1rem;">
        <div class="mono" style="font-size: 0.7rem; color: var(--ink-muted);">NO STORED MEMORIES YET</div>
        <p style="font-size: 0.82rem; color: var(--ink-secondary); margin-top: 0.35rem;">
          Add a goal, study preference, or weak spot below—or just talk to your Second Brain and it will automatically remember key facts about your routine and exams.
        </p>
      </div>
    `;
    return;
  }

  container.innerHTML = `
    <div class="hairline-list">
      ${memories.map(m => `
        <div class="hairline-row" style="padding: 0.65rem 0;">
          <div style="flex: 1; min-width: 0;">
            <div style="display: flex; align-items: center; gap: 0.45rem; margin-bottom: 0.2rem;">
              <span class="badge-minimal ${m.category === 'weak_spot' ? 'badge-gold' : m.category === 'goal' ? 'badge-emerald' : ''}">
                ${escapeHtml(MEMORY_CATEGORY_LABELS[m.category] || m.category)}
              </span>
            </div>
            <div style="font-size: 0.88rem; color: var(--ink-primary);">${escapeHtml(m.content)}</div>
          </div>
          <button class="btn btn-sm btn-ghost" data-del-memory="${m.id}" title="Forget memory">✕</button>
        </div>
      `).join('')}
    </div>
  `;

  container.querySelectorAll('button[data-del-memory]').forEach(btn => {
    btn.onclick = () => {
      apiMutate('delete_memory', {
        memory_id: Number(btn.getAttribute('data-del-memory'))
      });
    };
  });
}

function renderAll() {
  renderRailAndState();
  renderSingleFocusStage();
  renderTranscriptSheet();
  renderMemoryBankModal();
}

function initEvents() {
  // Left Rail View Switching
  document.querySelectorAll('.nav-item[data-view]').forEach(btn => {
    btn.onclick = () => {
      activeView = btn.getAttribute('data-view');
      renderAll();
    };
  });

  // Keyboard shortcuts 1-4 for views & Hold Spacebar for Push-to-Talk
  window.addEventListener('keydown', (e) => {
    const tag = document.activeElement?.tagName?.toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
    if (document.querySelector('.modal-backdrop.open')) return;

    if (e.key === '1') { activeView = 'now'; renderAll(); }
    else if (e.key === '2') { activeView = 'queue'; renderAll(); }
    else if (e.key === '3') { activeView = 'syllabus'; renderAll(); }
    else if (e.key === '4') { activeView = 'routines'; renderAll(); }
    else if (e.code === 'Space' && !e.repeat) {
      e.preventDefault();
      startVoiceRecording();
    }
  });

  window.addEventListener('keyup', (e) => {
    const tag = document.activeElement?.tagName?.toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
    if (e.code === 'Space' && isRecordingVoice) {
      e.preventDefault();
      stopVoiceRecording(true);
    }
  });

  // Voice Mic Button (Click to start recording, click again to stop & send)
  document.getElementById('voiceMicBtn').onclick = () => {
    if (isRecordingVoice) {
      stopVoiceRecording(true);
    } else {
      stopActiveSpeechPlayback();
      startVoiceRecording();
    }
  };

  // Stop Voice Playback Button
  const stopVoiceBtn = document.getElementById('stopSpeakingBtn');
  if (stopVoiceBtn) {
    stopVoiceBtn.onclick = () => stopActiveSpeechPlayback();
  }

  // Open Brain Dump from Bottom Bar
  const openDumpBarBtn = document.getElementById('openBrainDumpBarBtn');
  if (openDumpBarBtn) {
    openDumpBarBtn.onclick = () => openModal('brainDumpModal');
  }

  // Brain Dump Modal Submit & Voice Trigger
  const brainDumpForm = document.getElementById('brainDumpForm');
  if (brainDumpForm) {
    brainDumpForm.onsubmit = (e) => {
      e.preventDefault();
      const ta = document.getElementById('brainDumpTextarea');
      const rawText = ta?.value.trim() || '';
      if (!rawText) return;
      closeModal('brainDumpModal');
      ta.value = '';
      apiSendCopilotCommand(
        `[SECOND_BRAIN_DUMP] Process and organize my Brain Dump into queued actions, backlog tasks, study subjects/topics, study logs, state updates, and long-term Second Brain memories: ${rawText}`,
        null,
        null,
        true
      );
    };
  }
  const brainDumpVoiceBtn = document.getElementById('brainDumpVoiceBtn');
  if (brainDumpVoiceBtn) {
    brainDumpVoiceBtn.onclick = () => {
      closeModal('brainDumpModal');
      pendingVoiceContextPrefix = '[SECOND_BRAIN_DUMP] Process and organize this spoken Brain Dump into queued actions, backlog tasks, study subjects/topics, study logs, state updates, and long-term Second Brain memories: ';
      startVoiceRecording();
    };
  }

  // Memory Bank Add Form
  const addMemoryForm = document.getElementById('addMemoryForm');
  if (addMemoryForm) {
    addMemoryForm.onsubmit = (e) => {
      e.preventDefault();
      const contentEl = document.getElementById('memoryContentInput');
      const catEl = document.getElementById('memoryCategorySelect');
      if (!contentEl?.value.trim()) return;
      const content = contentEl.value.trim();
      contentEl.value = '';
      apiMutate('create_memory', {
        category: catEl?.value || 'note',
        content,
        importance: 4
      });
    };
  }

  // Co-Pilot Command Bar Submit
  document.getElementById('copilotForm').onsubmit = (e) => {
    e.preventDefault();
    if (isRecordingVoice) {
      stopVoiceRecording(true);
      return;
    }
    const input = document.getElementById('copilotInputBox');
    const msg = input.value.trim();
    if (!msg) return;
    input.value = '';
    apiSendCopilotCommand(msg);
  };

  // Co-Pilot Toast Undo & Dismiss
  document.getElementById('copilotUndoBtn').onclick = () => {
    document.getElementById('copilotToast').classList.remove('visible');
    apiMutate('undo_chat_op', { message_id: lastUndoMessageId });
  };
  document.getElementById('copilotDismissToastBtn').onclick = () => {
    document.getElementById('copilotToast').classList.remove('visible');
  };

  // Transcript History Sheet Toggle
  const sheet = document.getElementById('copilotTranscriptSheet');
  document.getElementById('toggleTranscriptBtn').onclick = () => sheet.classList.toggle('open');
  document.getElementById('closeTranscriptSheetBtn').onclick = () => sheet.classList.remove('open');

  const ttsBtn = document.getElementById('toggleTtsBtn');
  ttsBtn.onclick = () => {
    ttsEnabled = !ttsEnabled;
    if (!ttsEnabled) stopActiveSpeechPlayback();
    ttsBtn.textContent = `TTS: ${ttsEnabled ? 'ON' : 'OFF'}`;
  };

  // Close modal buttons
  document.querySelectorAll('button[data-close-modal]').forEach(btn => {
    btn.onclick = () => closeModal(btn.getAttribute('data-close-modal'));
  });

  // State Modal & Pills
  document.getElementById('openStateModalBtn').onclick = () => openModal('stateModal');
  document.querySelectorAll('#windowPillsContainer button').forEach(btn => {
    btn.onclick = () => {
      closeModal('stateModal');
      apiMutate('update_state', { available_minutes: Number(btn.getAttribute('data-window')) });
    };
  });
  document.querySelectorAll('#contextPillsContainer button').forEach(btn => {
    btn.onclick = () => {
      closeModal('stateModal');
      apiMutate('update_state', { context_location: btn.getAttribute('data-context') });
    };
  });
  document.querySelectorAll('#energyPillsContainer button').forEach(btn => {
    btn.onclick = () => {
      closeModal('stateModal');
      apiMutate('update_state', { energy_level: btn.getAttribute('data-energy') });
    };
  });

  // Exam Target Modal
  document.getElementById('openExamModalBtn').onclick = () => {
    const st = workspace?.userState;
    document.getElementById('examNameInput').value = st?.exam_name || '';
    document.getElementById('examDateInput').value = st?.exam_target_date || '';
    openModal('examTargetModal');
  };
  document.getElementById('examTargetForm').onsubmit = (e) => {
    e.preventDefault();
    closeModal('examTargetModal');
    apiMutate('update_state', {
      exam_name: document.getElementById('examNameInput').value.trim(),
      exam_target_date: document.getElementById('examDateInput').value
    });
  };

  // New Action Modal
  document.getElementById('newActionForm').onsubmit = (e) => {
    e.preventDefault();
    const titleEl = document.getElementById('modalActionTitle');
    if (!titleEl.value.trim()) return;
    closeModal('newActionModal');
    apiMutate('start_or_queue_action', {
      title: titleEl.value.trim(),
      notes: document.getElementById('modalActionNotes').value.trim(),
      category: document.getElementById('modalActionCategory').value,
      study_mode: document.getElementById('modalActionStudyMode').value || null,
      estimated_minutes: Number(document.getElementById('modalActionMins').value) || 35,
      mode: 'queue'
    });
    titleEl.value = '';
    document.getElementById('modalActionNotes').value = '';
  };

  // Log Study Modal
  document.getElementById('modalStudyLogForm').onsubmit = (e) => {
    e.preventDefault();
    const topicEl = document.getElementById('modalLogTopicInput');
    if (!topicEl.value.trim()) return;
    closeModal('logStudyModal');
    apiMutate('create_study_log', {
      subject_id: Number(document.getElementById('modalLogSubjectSelect').value) || null,
      study_mode: document.getElementById('modalLogStudyModeSelect').value,
      duration_minutes: Number(document.getElementById('modalLogDurationInput').value) || 45,
      topic_covered: topicEl.value.trim(),
      perceived_outcome: 'Logged via Study Tracker',
      needs_followup_next: document.getElementById('modalLogFollowupInput').value.trim()
    });
    topicEl.value = '';
    document.getElementById('modalLogFollowupInput').value = '';
  };

  // Subject Modal
  document.getElementById('subjectModalForm').onsubmit = (e) => {
    e.preventDefault();
    const idVal = document.getElementById('subjectModalId').value;
    closeModal('subjectModal');
    apiMutate(idVal ? 'update_subject' : 'create_subject', {
      id: idVal ? Number(idVal) : undefined,
      name: document.getElementById('subjectNameInput').value.trim(),
      code_or_area: document.getElementById('subjectCodeInput').value.trim(),
      priority: document.getElementById('subjectPrioritySelect').value,
      current_focus_notes: document.getElementById('subjectNotesInput').value.trim()
    });
  };

  // Routine / Habit Modal
  const routineTypeSel = document.getElementById('routineTypeSelect');
  const routineStepsBox = document.getElementById('routineSequenceStepsBox');
  routineTypeSel.onchange = () => {
    routineStepsBox.style.display = routineTypeSel.value === 'block_sequence' ? 'block' : 'none';
  };
  document.getElementById('routineModalForm').onsubmit = (e) => {
    e.preventDefault();
    const nameEl = document.getElementById('routineNameInput');
    if (!nameEl.value.trim()) return;
    const rType = routineTypeSel.value;
    const windowVal = document.getElementById('routineWindowSelect').value;
    const minsVal = Number(document.getElementById('routineMinsInput').value) || 25;
    const rawLines = document.getElementById('routineStepsTextarea').value
      .split('\n')
      .map(l => l.trim())
      .filter(Boolean);

    const steps = rType === 'block_sequence' && rawLines.length > 0
      ? rawLines.map(line => {
          const parts = line.split(':');
          if (parts.length > 1 && !Number.isNaN(Number(parts[parts.length - 1].trim()))) {
            const stepMins = Number(parts.pop().trim());
            return { title: parts.join(':').trim(), category: 'study', estimated_minutes: stepMins };
          }
          return { title: line, category: 'study', estimated_minutes: 20 };
        })
      : [{ title: nameEl.value.trim(), category: 'study', estimated_minutes: minsVal }];

    closeModal('routineModal');
    apiMutate('create_routine', {
      name: nameEl.value.trim(),
      routine_type: rType,
      time_of_day_window: windowVal,
      estimated_minutes: minsVal,
      category: 'study',
      steps_json: steps
    });
    nameEl.value = '';
    document.getElementById('routineStepsTextarea').value = '';
  };

  // Password Gate Modal
  document.getElementById('passwordGateForm').onsubmit = (e) => {
    e.preventDefault();
    const pw = document.getElementById('accessPasswordInput').value;
    setSavedAccessPassword(pw);
    closeModal('passwordGateModal');
    apiFetchWorkspace();
  };

  // Theme Toggle
  document.getElementById('themeSwitchBtn').onclick = () => {
    const html = document.documentElement;
    const next = html.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
    html.setAttribute('data-theme', next);
  };

  // Gemini Settings
  document.getElementById('openSettingsBtn').onclick = () => {
    document.getElementById('geminiApiKeyInput').value = getSavedApiKey();
    if (workspace?.userState?.gemini_model) {
      document.getElementById('geminiModelSelect').value = workspace.userState.gemini_model;
    }
    openModal('settingsModalBackdrop');
  };
  document.getElementById('settingsForm').onsubmit = (e) => {
    e.preventDefault();
    setSavedApiKey(document.getElementById('geminiApiKeyInput').value);
    const model = document.getElementById('geminiModelSelect').value;
    closeModal('settingsModalBackdrop');
    apiMutate('update_state', { gemini_model: model });
  };

  // 1-second timer tick
  setInterval(() => {
    if (timerRunning && activeTimerActionId && timerRemainingSec > 0) {
      timerRemainingSec -= 1;
      const el = document.getElementById('activeTimerReadout');
      if (el) el.textContent = formatSec(timerRemainingSec);
    }
  }, 1000);

  apiFetchWorkspace();
}

window.addEventListener('DOMContentLoaded', initEvents);
