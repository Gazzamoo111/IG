const API = "https://nslfyglqamrhbqfdwftr.supabase.co/functions/v1/mova-scan";
const app = document.getElementById("app");
const footer = document.getElementById("kit-footer");
const params = new URLSearchParams(location.search);
const tokenFromUrl = params.get("t");
if (tokenFromUrl) localStorage.setItem("mova_last_token", tokenFromUrl);
const token = tokenFromUrl || localStorage.getItem("mova_last_token");

const OFFLINE_PACK_KEY = "mova_offline_pack_v1";
const OFFLINE_QUEUE_KEY = "mova_offline_queue_v1";
let installPrompt = null;
let syncInFlight = false;

const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent) ||
  (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const isStandalone = window.matchMedia?.("(display-mode: standalone)")?.matches ||
  navigator.standalone === true;

let kit = null;
let duration = null;
let goal = null;
let run = null;

let sequence = [];
let currentIndex = 0;
let phase = "idle";
let phaseSeconds = 0;
let elapsedSeconds = 0;
let timerId = null;
let paused = false;
let easier = false;
let alternateVersion = 0;
let wakeLock = null;
let sessionStartLogged = false;
let progressSummary = null;
let showcaseReturnRun = null;
let showcaseReturnGoal = null;

const deviceId = getDeviceId();

function getDeviceId() {
  let id = localStorage.getItem("mova_device_id");
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem("mova_device_id", id);
  }
  return id;
}

function readJson(key, fallback) {
  try {
    const value = JSON.parse(localStorage.getItem(key) || "null");
    return value ?? fallback;
  } catch (_) {
    return fallback;
  }
}

function writeJson(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch (_) {}
}

function getOfflinePack() {
  const pack = readJson(OFFLINE_PACK_KEY, null);
  return pack?.token === token ? pack : null;
}

function getOfflineQueue() {
  return readJson(OFFLINE_QUEUE_KEY, []);
}

function setOfflineQueue(queue) {
  writeJson(OFFLINE_QUEUE_KEY, queue);
  updateNetworkStatus();
}

function networkError(message = "Network unavailable") {
  const error = new Error(message);
  error.movaNetwork = true;
  return error;
}

async function networkApi(action, payload = {}) {
  let response;
  try {
    response = await fetch(API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, device_id: deviceId, action, ...payload })
    });
  } catch (_) {
    throw networkError();
  }

  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "MOVA could not complete that request.");
  return data;
}

function offlineEquipmentOrder(goalValue) {
  return {
    loosen_up: ["handle_band", "mini_band", "bar", "bodyweight"],
    get_moving: ["mini_band", "handle_band", "bar", "bodyweight"],
    get_stronger: ["bar", "handle_band", "mini_band", "bodyweight"],
    whole_body: ["bar", "handle_band", "mini_band", "bodyweight"]
  }[goalValue] || ["bar", "handle_band", "mini_band", "bodyweight"];
}

function cachedSession(durationValue, goalValue, equipmentValue = null) {
  const pack = getOfflinePack();
  if (!pack?.sessions?.length) return null;
  const candidates = pack.sessions.filter(session =>
    Number(session.duration) === Number(durationValue) &&
    session.goal === goalValue &&
    session.content_ready
  );
  if (!candidates.length) return null;
  if (equipmentValue) return candidates.find(session => session.equipment === equipmentValue) || null;

  const order = offlineEquipmentOrder(goalValue);
  const ranked = order.map(eq => candidates.find(session => session.equipment === eq)).filter(Boolean);
  if (!ranked.length) return candidates[0];

  const last = progressSummary?.last_session;
  if (ranked.length > 1 && last?.goal === goalValue && last?.equipment === ranked[0].equipment) {
    return ranked[1];
  }
  return ranked[0];
}

function updateOfflineProgress(status, elapsed) {
  progressSummary ||= {
    returning_user: true,
    week: { sessions: 0, movement_minutes: 0, active_days: 0, streak_days: 0, favourite_goal: null },
    total_completed_sessions: 0,
    last_session: null
  };
  progressSummary.returning_user = true;
  progressSummary.week ||= {};
  const minutes = Math.round(Math.max(0, Number(elapsed || 0)) / 60);
  progressSummary.week.movement_minutes = Number(progressSummary.week.movement_minutes || 0) + minutes;
  progressSummary.week.streak_days = Math.max(1, Number(progressSummary.week.streak_days || 0));
  progressSummary.week.active_days = Math.max(1, Number(progressSummary.week.active_days || 0));

  if (status === "completed") {
    progressSummary.week.sessions = Number(progressSummary.week.sessions || 0) + 1;
    progressSummary.total_completed_sessions = Number(progressSummary.total_completed_sessions || 0) + 1;
    progressSummary.last_session = {
      duration_minutes: duration,
      goal,
      equipment: run?.equipment || null,
      completed_at: new Date().toISOString()
    };
  }

  const pack = getOfflinePack();
  if (pack) {
    pack.summary = progressSummary;
    writeJson(OFFLINE_PACK_KEY, pack);
  }
}

function queueOfflineRun(status, payload = {}) {
  if (!run?.offline || !run.run_id) return;
  const queue = getOfflineQueue();
  const existing = queue.find(item => item.run_id === run.run_id);
  const item = existing || {
    run_id: run.run_id,
    duration,
    goal,
    equipment: run.equipment,
    started_at: run.offline_started_at || new Date().toISOString(),
    skips: []
  };

  item.status = status;
  item.elapsed_seconds = Math.max(0, Math.round(Number(payload.elapsed_seconds || 0)));
  item.ended_at = new Date().toISOString();
  item.skips = Array.isArray(run.offline_skips) ? run.offline_skips : item.skips || [];

  const next = queue.filter(entry => entry.run_id !== item.run_id);
  next.push(item);
  setOfflineQueue(next);
  updateOfflineProgress(status, item.elapsed_seconds);
}

function updateQueuedFeedback(runId, feedback) {
  const queue = getOfflineQueue();
  const item = queue.find(entry => entry.run_id === runId);
  if (!item) return false;
  item.feedback = feedback;
  setOfflineQueue(queue);
  return true;
}

async function offlineApi(action, payload = {}) {
  const pack = getOfflinePack();
  if (!pack) return null;

  if (run?.offline && payload.run_id === run.run_id) {
    if (action === "session_started") {
      run.offline_started_at = new Date().toISOString();
      return { ok: true, offline: true };
    }
    if (action === "movement_skipped") {
      run.offline_skips ||= [];
      run.offline_skips.push({
        movement_index: Number(payload.movement_index || 0),
        movement_label: String(payload.movement_label || "")
      });
      return { ok: true, offline: true };
    }
    if (action === "session_completed" || action === "session_stopped") {
      queueOfflineRun(action === "session_completed" ? "completed" : "stopped", payload);
      if (navigator.onLine) setTimeout(flushOfflineQueue, 0);
      return { ok: true, offline: true, queued: true };
    }
    if (action === "feedback") {
      const queued = updateQueuedFeedback(run.run_id, payload.feedback);
      if (!queued && navigator.onLine) {
        return await networkApi("feedback", payload);
      }
      if (navigator.onLine) setTimeout(flushOfflineQueue, 0);
      return { ok: true, offline: true, queued: true };
    }
  }

  if (action === "scan") {
    return { ok: true, kit: pack.kit, summary: progressSummary || pack.summary || null, offline: true };
  }
  if (action === "device_summary") {
    return { ok: true, summary: progressSummary || pack.summary || null, offline: true };
  }
  if (action === "select_time") return { ok: true, offline: true };

  if (action === "preview_session") {
    const session = cachedSession(payload.duration, payload.goal, payload.equipment);
    return session ? { ok: true, ...session, offline: true } : null;
  }

  if (action === "select_goal") {
    const session = cachedSession(payload.duration, payload.goal, payload.equipment || null);
    if (!session) return null;
    return {
      ok: true,
      ...session,
      run_id: crypto.randomUUID(),
      offline: true,
      offline_started_at: null,
      offline_skips: []
    };
  }

  return null;
}

async function api(action, payload = {}) {
  if (run?.offline && payload.run_id === run.run_id) {
    const local = await offlineApi(action, payload);
    if (local) return local;
  }

  if (!navigator.onLine) {
    const local = await offlineApi(action, payload);
    if (local) return local;
    throw new Error("This MOVA session is not available offline yet. Reconnect once to download the kit.");
  }

  try {
    return await networkApi(action, payload);
  } catch (error) {
    if (error?.movaNetwork) {
      const local = await offlineApi(action, payload);
      if (local) return local;
    }
    throw error;
  }
}

async function warmOfflinePack() {
  if (!navigator.onLine || !token) return;
  try {
    const pack = await networkApi("offline_pack");
    writeJson(OFFLINE_PACK_KEY, { ...pack, token });
  } catch (_) {}
}

async function flushOfflineQueue() {
  if (syncInFlight || !navigator.onLine || !token) return;
  const queue = getOfflineQueue();
  if (!queue.length) {
    updateNetworkStatus();
    return;
  }

  syncInFlight = true;
  updateNetworkStatus();

  const remaining = [];
  for (const item of queue) {
    try {
      await networkApi("offline_session_sync", { offline_session: item });
    } catch (_) {
      remaining.push(item);
    }
  }

  setOfflineQueue(remaining);
  if (!remaining.length) {
    try {
      const data = await networkApi("device_summary");
      progressSummary = data.summary || progressSummary;
      const pack = getOfflinePack();
      if (pack) {
        pack.summary = progressSummary;
        writeJson(OFFLINE_PACK_KEY, pack);
      }
    } catch (_) {}
  }

  syncInFlight = false;
  updateNetworkStatus();
}

function updateNetworkStatus() {
  const el = document.getElementById("network-status");
  if (!el) return;
  const queued = getOfflineQueue().length;

  if (!navigator.onLine) {
    el.hidden = false;
    el.className = "network-status offline";
    el.textContent = queued ? `Offline · ${queued} session${queued === 1 ? "" : "s"} waiting to sync` : "Offline mode";
    return;
  }

  if (syncInFlight) {
    el.hidden = false;
    el.className = "network-status syncing";
    el.textContent = "Syncing MOVA…";
    return;
  }

  if (queued) {
    el.hidden = false;
    el.className = "network-status syncing";
    el.textContent = `${queued} session${queued === 1 ? "" : "s"} waiting to sync`;
    return;
  }

  el.hidden = true;
}

function cacheSessionMedia(steps) {
  if (!navigator.onLine || !Array.isArray(steps) || !("serviceWorker" in navigator)) return;
  const urls = Array.from(new Set(
    steps.flatMap(step => [
      step.demo_asset_url,
      step.easier_demo_asset_url,
      step.alternate?.demo_asset_url
    ]).filter(Boolean)
  ));
  if (!urls.length) return;

  navigator.serviceWorker.ready
    .then(registration => registration.active?.postMessage({ type: "CACHE_MEDIA", urls }))
    .catch(() => {});
}

async function requestInstall() {
  if (installPrompt) {
    installPrompt.prompt();
    try { await installPrompt.userChoice; } catch (_) {}
    installPrompt = null;
    return;
  }
  if (isIos && !isStandalone) renderInstallHelp();
}

function renderInstallHelp() {
  render(`
    <button class="back-btn" id="install-back" type="button">← Back</button>
    <div class="eyebrow">Install MOVA</div>
    <h1>Add MOVA to your Home Screen.</h1>
    <div class="install-card">
      <div class="install-step"><strong>1</strong><span>Tap the <b>Share</b> button in Safari.</span></div>
      <div class="install-step"><strong>2</strong><span>Choose <b>Add to Home Screen</b>.</span></div>
      <div class="install-step"><strong>3</strong><span>Tap <b>Add</b>. MOVA will open like an app.</span></div>
    </div>
  `);
  document.getElementById("install-back").addEventListener("click", renderHome);
}

function registerPwa() {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  }

  window.addEventListener("beforeinstallprompt", event => {
    event.preventDefault();
    installPrompt = event;
    if (progressSummary?.returning_user && phase === "idle") renderHome();
  });

  window.addEventListener("appinstalled", () => {
    installPrompt = null;
  });

  window.addEventListener("online", () => {
    updateNetworkStatus();
    flushOfflineQueue();
    warmOfflinePack();
  });

  window.addEventListener("offline", updateNetworkStatus);
  updateNetworkStatus();
}

function render(html) { app.innerHTML = html; }
function bind(selector, fn) { document.querySelectorAll(selector).forEach(el => el.addEventListener("click", fn)); }

function showError(message) {
  clearPlayerTimer();
  document.body.classList.remove("session-mode");
  render(`
    <div class="eyebrow">MOVA</div>
    <h1>We couldn't open this kit.</h1>
    <p class="lead">Check the QR and try again.</p>
    <div class="error-box">${escapeHtml(message)}</div>
  `);
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}

async function boot() {
  if (!token) return showError("No MOVA kit token was found in this link.");
  render(`<div class="loader-wrap"><div class="loader"></div><div>Opening your MOVA kit…</div></div>`);
  try {
    const data = await api("scan");
    kit = data.kit;
    progressSummary = data.summary || getOfflinePack()?.summary || null;
    footer.textContent = `${kit.code} · MOVA`;
    updateNetworkStatus();
    if (navigator.onLine) {
      warmOfflinePack();
      flushOfflineQueue();
    }
    if (progressSummary?.returning_user) renderHome();
    else renderTime();
  } catch (error) {
    showError(error.message);
  }
}

function goalLabel(value) {
  return {
    loosen_up: "Loosen Up",
    get_moving: "Get Moving",
    get_stronger: "Get Stronger",
    whole_body: "Whole Body"
  }[value] || "Movement";
}

function equipmentName(value) {
  return {
    bar: "MOVA Bar",
    handle_band: "Handle Band",
    mini_band: "Mini Band",
    bodyweight: "No Kit"
  }[value] || "MOVA";
}

async function refreshProgress() {
  try {
    const data = await api("device_summary");
    progressSummary = data.summary || progressSummary;
    const pack = getOfflinePack();
    if (pack && progressSummary) {
      pack.summary = progressSummary;
      writeJson(OFFLINE_PACK_KEY, pack);
    }
  } catch (_) {}
  return progressSummary;
}

function progressCardsHtml(summary = progressSummary) {
  const week = summary?.week || {};
  return `
    <div class="progress-cards">
      <div class="progress-card"><strong>${Number(week.movement_minutes || 0)}</strong><span>MIN THIS WEEK</span></div>
      <div class="progress-card"><strong>${Number(week.sessions || 0)}</strong><span>SESSIONS</span></div>
      <div class="progress-card"><strong>${Number(week.streak_days || 0)}</strong><span>DAY STREAK</span></div>
    </div>
  `;
}

function renderHome() {
  resetPlayerState();
  document.body.classList.remove("session-mode");
  const last = progressSummary?.last_session;
  const lastCopy = last
    ? `Last session: <strong>${Number(last.duration_minutes)} min · ${escapeHtml(goalLabel(last.goal))}</strong>`
    : "Your next session is ready when you are.";

  render(`
    <div class="safety"><span class="safety-dot"></span>Parked. Secure. Clear. Free to move.</div>
    <div class="eyebrow">Welcome back</div>
    <h1>Ready to move?</h1>
    <p class="lead home-last">${lastCopy}</p>
    ${progressCardsHtml()}
    <div class="action-stack home-actions">
      <button class="primary-btn" id="home-start">Start a session</button>
      <button class="secondary-btn" id="home-progress">My progress</button>
      ${(installPrompt || (isIos && !isStandalone)) ? '<button class="text-btn" id="install-mova">Install MOVA</button>' : ""}
    </div>
  `);

  document.getElementById("home-start").addEventListener("click", renderTime);
  document.getElementById("home-progress").addEventListener("click", renderProgress);
  if (installPrompt || (isIos && !isStandalone)) {
    document.getElementById("install-mova")?.addEventListener("click", requestInstall);
  }
}

function renderProgress() {
  const week = progressSummary?.week || {};
  render(`
    <button class="back-btn" id="progress-back" type="button">← Back</button>
    <div class="eyebrow">My MOVA</div>
    <h1>Your movement.</h1>
    <p class="lead">A simple view of the movement recorded on this device.</p>
    ${progressCardsHtml()}
    <div class="progress-detail-card">
      <div class="progress-detail-row"><span>Active days this week</span><strong>${Number(week.active_days || 0)}</strong></div>
      <div class="progress-detail-row"><span>Total completed sessions</span><strong>${Number(progressSummary?.total_completed_sessions || 0)}</strong></div>
      <div class="progress-detail-row"><span>Most-used goal this week</span><strong>${week.favourite_goal ? escapeHtml(goalLabel(week.favourite_goal)) : "—"}</strong></div>
    </div>
    <div class="privacy-note">Progress is linked to this device for the demo. No name or personal health profile is required.</div>
    <div class="action-stack">
      <button class="primary-btn" id="progress-start">Start a session</button>
    </div>
  `);
  document.getElementById("progress-back").addEventListener("click", renderHome);
  document.getElementById("progress-start").addEventListener("click", renderTime);
}

function renderTime() {
  resetPlayerState();
  document.body.classList.remove("session-mode");
  render(`
    ${progressSummary?.returning_user ? '<button class="back-btn" id="time-home" type="button">← Home</button>' : ""}
    <div class="safety"><span class="safety-dot"></span>Parked. Secure. Clear. Free to move.</div>
    <h1>How much time have you got?</h1>
    <p class="lead">Pick the time. MOVA handles the rest.</p>
    <div class="time-grid">
      <button class="time-btn" data-time="3">3<span>MIN</span></button>
      <button class="time-btn recommended" data-time="5">5<span>MIN</span></button>
      <button class="time-btn" data-time="10">10<span>MIN</span></button>
    </div>
  `);

  if (progressSummary?.returning_user) {
    document.getElementById("time-home").addEventListener("click", renderHome);
  }

  bind("[data-time]", (event) => {
    duration = Number(event.currentTarget.dataset.time);
    api("select_time", { duration }).catch(() => {});
    renderGoal();
  });
}

function renderGoal() {
  render(`
    <button class="back-btn" id="back-to-time" type="button">← Back</button>
    <div class="eyebrow">${duration} minutes</div>
    <h1>What do you need?</h1>
    <p class="lead">Pick the outcome. MOVA selects the best tool from your kit.</p>
    <div class="goal-list">
      ${goalButton("loosen_up", "Loosen Up", "Move after sitting")}
      ${goalButton("get_moving", "Get Moving", "Get the body working")}
      ${goalButton("get_stronger", "Get Stronger", "Simple resistance and strength")}
      ${goalButton("whole_body", "Whole Body", "A balanced mix")}
    </div>
  `);

  document.getElementById("back-to-time").addEventListener("click", renderTime);

  bind("[data-goal]", async (event) => {
    goal = event.currentTarget.dataset.goal;
    render(`<div class="loader-wrap"><div class="loader"></div><div>Building your session…</div></div>`);
    try {
      run = await api("select_goal", { duration, goal });
      renderReady();
    } catch (error) {
      showError(error.message);
    }
  });
}

function goalButton(value, title, desc) {
  return `<button class="goal-btn" data-goal="${value}"><span class="goal-copy">${title}<small>${desc}</small></span><span class="goal-arrow">›</span></button>`;
}

function movementPreviewHtml(steps) {
  if (!Array.isArray(steps) || !steps.length) return "";
  return `
    <details class="session-preview">
      <summary>What's in this session?</summary>
      <ol>
        ${steps.map(step => `<li><span>${escapeHtml(step.name)}</span><small>${Number(step.duration_seconds)} sec</small></li>`).join("")}
      </ol>
    </details>
  `;
}

function buildShowcaseRun() {
  const base = "./media/showcase.html";
  const demoStep = (order, name, cue, move, easierName, easierCue) => ({
    order,
    name,
    cue,
    easier_name: easierName,
    easier_cue: easierCue,
    duration_seconds: 42,
    transition_seconds: order < 4 ? 4 : 0,
    demo_asset_url: `${base}?move=${move}`,
    easier_demo_asset_url: `${base}?move=${move}&variant=easier`,
    alternate: null
  });

  return {
    showcase_demo: true,
    run_id: "mova-showcase-local",
    equipment: "handle_band",
    equipment_label: "MOVA Handle Band",
    title: "3-Min Visual Showcase",
    level: 1,
    content_ready: true,
    steps: [
      demoStep(1, "Handle Band Squat", "Sit back, keep the chest tall, then stand strong.", "squat", "Shallow Band Squat", "Use a smaller comfortable range."),
      demoStep(2, "Standing Band Row", "Pull the handles towards the ribs and squeeze between the shoulders.", "row", "Short-Range Band Row", "Use a shorter pull and keep the shoulders relaxed."),
      demoStep(3, "Band Bicep Curl", "Keep the elbows close and curl with control.", "curl", "Light Band Curl", "Reduce the band tension and keep the range comfortable."),
      demoStep(4, "Band Chest Press", "Press forward smoothly, keeping the ribs stacked.", "chest_press", "Short-Range Chest Press", "Press through a smaller comfortable range.")
    ]
  };
}

function startShowcaseDemo() {
  if (duration !== 3 || run?.showcase_demo) return;
  showcaseReturnRun = run;
  showcaseReturnGoal = goal;
  run = buildShowcaseRun();
  goal = "whole_body";
  startSession();
}

function leaveShowcase() {
  clearPlayerTimer();
  releaseWakeLock();
  document.body.classList.remove("session-mode");
  run = showcaseReturnRun;
  goal = showcaseReturnGoal;
  showcaseReturnRun = null;
  showcaseReturnGoal = null;
  phase = "idle";
  sessionStartLogged = false;
  renderReady();
}

function renderReady() {
  cacheSessionMedia(run?.steps);
  const goalTitle = {
    loosen_up: "Loosen Up",
    get_moving: "Get Moving",
    get_stronger: "Get Stronger",
    whole_body: "Whole Body"
  }[goal];

  const stepCount = Array.isArray(run.steps) && run.steps.length ? run.steps.length : null;

  render(`
    <button class="back-btn" id="back-to-goal" type="button">← Back</button>
    <div class="eyebrow">${duration} min · ${goalTitle}</div>
    <h1>Your session is ready.</h1>
    <p class="lead">MOVA picked this session for you. Start now, or change the time or equipment.</p>
    <div class="card">
      <div class="card-label">Selected equipment</div>
      <div class="equipment-name">${escapeHtml(run.equipment_label)}</div>
      <div class="session-title">${escapeHtml(run.title)}</div>
      <div class="session-meta">
        <span class="pill">${duration} min</span>
        <span class="pill">Level ${run.level}</span>
        <span class="pill">One tool</span>
        ${stepCount ? `<span class="pill">${stepCount} movements</span>` : ""}
      </div>
    </div>

    ${movementPreviewHtml(run.steps)}

    <div class="action-stack ready-actions">
      <button class="primary-btn" id="start-session">Start session</button>
      ${duration === 3 && !run?.showcase_demo ? '<button class="showcase-btn" id="showcase-demo" type="button"><span>Visual showcase</span><small>See what the finished exercise experience can look like</small></button>' : ""}
      <button class="secondary-btn" id="change-session">Change time or equipment</button>
    </div>
  `);

  document.getElementById("back-to-goal").addEventListener("click", renderGoal);
  document.getElementById("start-session").addEventListener("click", startSession);
  document.getElementById("showcase-demo")?.addEventListener("click", startShowcaseDemo);
  document.getElementById("change-session").addEventListener("click", renderSessionOptions);
}

function equipmentOptions() {
  const available = [];
  if (kit?.equipment?.bar) available.push(["bar", "MOVA Bar"]);
  if (kit?.equipment?.handle_band) available.push(["handle_band", "Handle Band"]);
  if (kit?.equipment?.mini_band) available.push(["mini_band", "Mini Band"]);
  available.push(["bodyweight", "No Kit"]);
  return available;
}

async function renderSessionOptions() {
  let selectedDuration = duration;
  let selectedEquipment = run.equipment;
  let preview = {
    duration,
    equipment: run.equipment,
    equipment_label: run.equipment_label,
    title: run.title,
    level: run.level,
    steps: run.steps || []
  };

  const goalTitle = {
    loosen_up: "Loosen Up",
    get_moving: "Get Moving",
    get_stronger: "Get Stronger",
    whole_body: "Whole Body"
  }[goal];

  function draw() {
    render(`
      <button class="back-btn" id="option-back-top" type="button">← Back</button>
      <div class="eyebrow">${escapeHtml(goalTitle)}</div>
      <h1>Choose another session.</h1>
      <p class="lead">Keep the same goal and change the time, the equipment, or both.</p>

      <div class="option-section">
        <div class="option-label">Time</div>
        <div class="option-time-grid">
          ${[3,5,10].map(value => `
            <button class="option-chip ${selectedDuration===value ? "selected" : ""}" data-option-time="${value}">
              ${value} min
            </button>
          `).join("")}
        </div>
      </div>

      <div class="option-section">
        <div class="option-label">Equipment</div>
        <div class="option-equipment-grid">
          ${equipmentOptions().map(([value,label]) => `
            <button class="option-equipment ${selectedEquipment===value ? "selected" : ""}" data-option-equipment="${value}">
              <span>${escapeHtml(label)}</span>
            </button>
          `).join("")}
        </div>
      </div>

      <div id="option-preview">
        ${previewCard()}
      </div>

      <div class="action-stack">
        <button class="primary-btn" id="use-option">Use this session</button>
        <button class="secondary-btn" id="option-back">Back</button>
      </div>
    `);

    document.querySelectorAll("[data-option-time]").forEach(btn => btn.addEventListener("click", async () => {
      selectedDuration = Number(btn.dataset.optionTime);
      await refreshPreview();
    }));

    document.querySelectorAll("[data-option-equipment]").forEach(btn => btn.addEventListener("click", async () => {
      selectedEquipment = btn.dataset.optionEquipment;
      await refreshPreview();
    }));

    document.getElementById("option-back-top").addEventListener("click", renderReady);
    document.getElementById("use-option").addEventListener("click", useOption);
    document.getElementById("option-back").addEventListener("click", renderReady);
  }

  function previewCard() {
    return `
      <div class="option-preview-card">
        <div class="card-label">Preview</div>
        <div class="equipment-name">${escapeHtml(preview.equipment_label || "")}</div>
        <div class="session-title">${escapeHtml(preview.title || "")}</div>
        <div class="session-meta">
          <span class="pill">${selectedDuration} min</span>
          <span class="pill">Level ${preview.level || 1}</span>
        </div>
        ${movementPreviewHtml(preview.steps)}
      </div>
    `;
  }

  async function refreshPreview() {
    render(`<div class="loader-wrap"><div class="loader"></div><div>Loading session…</div></div>`);
    try {
      preview = await api("preview_session", {
        duration: selectedDuration,
        goal,
        equipment: selectedEquipment
      });
      draw();
    } catch (error) {
      showError(error.message);
    }
  }

  async function useOption() {
    render(`<div class="loader-wrap"><div class="loader"></div><div>Building your session…</div></div>`);
    try {
      duration = selectedDuration;
      run = await api("select_goal", {
        duration,
        goal,
        equipment: selectedEquipment
      });
      renderReady();
    } catch (error) {
      showError(error.message);
    }
  }

  draw();
}

function buildFallbackSequence(minutes) {
  const count = minutes === 3 ? 4 : minutes === 5 ? 5 : 10;
  const transition = minutes === 3 ? 2 : 3;
  const transitionTotal = transition * (count - 1);
  const activeTotal = (minutes * 60) - transitionTotal;
  const base = Math.floor(activeTotal / count);
  let remainder = activeTotal - (base * count);

  return Array.from({ length: count }, (_, i) => ({
    id: i + 1,
    label: `Movement ${String(i + 1).padStart(2, "0")}`,
    cue: "Move with control.",
    easierLabel: `Easier Movement ${String(i + 1).padStart(2, "0")}`,
    easierCue: "Use a smaller comfortable range.",
    altLabel: `Alternate ${String(i + 1).padStart(2, "0")}`,
    altCue: "Use the alternate movement.",
    seconds: base + (remainder-- > 0 ? 1 : 0),
    transition: i === count - 1 ? 0 : transition,
    demo: null,
    easierDemo: null,
    altDemo: null
  }));
}

function sequenceFromRun() {
  if (!run?.content_ready || !Array.isArray(run.steps) || !run.steps.length) {
    return buildFallbackSequence(duration);
  }
  return run.steps.map((step, index) => ({
    id: step.order || index + 1,
    label: step.name,
    cue: step.cue || "",
    easierLabel: step.easier_name || null,
    easierCue: step.easier_cue || null,
    altLabel: step.alternate?.name || null,
    altCue: step.alternate?.cue || null,
    seconds: Number(step.duration_seconds),
    transition: Number(step.transition_seconds || 0),
    demo: step.demo_asset_url || null,
    easierDemo: step.easier_demo_asset_url || null,
    altDemo: step.alternate?.demo_asset_url || null
  }));
}

function totalSessionSeconds() {
  return sequence.reduce((sum, step) => sum + step.seconds + step.transition, 0);
}

function plannedPositionSeconds() {
  if (!sequence.length) return 0;
  if (phase === "complete") return totalSessionSeconds();
  if (phase === "prestart" || phase === "idle") return 0;

  let done = 0;
  for (let i = 0; i < currentIndex; i++) {
    done += sequence[i].seconds + sequence[i].transition;
  }

  const current = sequence[currentIndex];
  if (!current) return done;

  if (phase === "work") {
    done += Math.max(0, current.seconds - phaseSeconds);
  } else if (phase === "transition") {
    done += current.seconds + Math.max(0, current.transition - phaseSeconds);
  }

  return Math.min(totalSessionSeconds(), done);
}

async function startSession() {
  sequence = sequenceFromRun();
  currentIndex = 0;
  elapsedSeconds = 0;
  paused = false;
  easier = false;
  alternateVersion = 0;
  sessionStartLogged = false;
  document.body.classList.add("session-mode");
  await requestWakeLock();
  startPreCountdown();
}

function logSessionStarted() {
  if (sessionStartLogged || !run?.run_id) return;
  sessionStartLogged = true;
  if (run?.showcase_demo) return;
  api("session_started", { run_id: run.run_id }).catch(() => {});
}

function startPreCountdown() {
  clearPlayerTimer();
  phase = "prestart";
  phaseSeconds = 3;
  renderPlayerShell();
  updatePlayerUI();
  timerId = setInterval(tickPlayer, 1000);
}

function beginMovement(index) {
  phase = "work";
  currentIndex = index;
  phaseSeconds = sequence[currentIndex].seconds;
  easier = false;
  alternateVersion = 0;
  vibrate(35);
  updatePlayerUI();
}

function beginTransition() {
  const transition = sequence[currentIndex].transition || 0;
  if (transition <= 0) {
    beginMovement(currentIndex + 1);
    return;
  }
  phase = "transition";
  phaseSeconds = transition;
  easier = false;
  alternateVersion = 0;
  vibrate([40, 35, 40]);
  updatePlayerUI();
}

function tickPlayer() {
  if (paused) return;

  if (phase === "prestart") {
    phaseSeconds -= 1;
    if (phaseSeconds <= 0) {
      logSessionStarted();
      beginMovement(0);
      return;
    }
    vibrate(20);
    updatePlayerUI();
    return;
  }

  if (phase === "work" || phase === "transition") {
    elapsedSeconds += 1;
    phaseSeconds -= 1;

    if (phaseSeconds <= 0) {
      if (phase === "work") {
        if (currentIndex >= sequence.length - 1) {
          completeSession();
          return;
        }
        beginTransition();
        return;
      }
      beginMovement(currentIndex + 1);
      return;
    }

    updatePlayerUI();
  }
}

function renderPlayerShell() {
  render(`
    <div class="player ${run?.showcase_demo ? "showcase-player" : ""}">
      ${run?.showcase_demo ? '<div class="showcase-ribbon"><span>VISUAL SHOWCASE</span><small>Demo only · not recorded</small></div>' : ""}
      <div class="player-top">
        <span id="player-meta"></span>
        <span id="overall-remaining"></span>
      </div>
      <div class="progress"><div id="progress-fill"></div></div>

      <div class="player-stage equipment-${escapeHtml(run.equipment)}" id="player-stage">
        <div class="timer" id="movement-timer"></div>
        <div class="stage-demo" id="stage-demo"></div>
        <div class="stage-badge" id="stage-badge">STANDARD</div>
        <div class="pause-overlay" id="pause-overlay" hidden><strong>Paused</strong><span>Resume when you're ready.</span></div>
      </div>

      <div>
        <div class="player-title" id="movement-title"></div>
        <div class="player-cue" id="movement-cue"></div>
      </div>

      <div class="player-controls">
        <button type="button" id="easier-btn">Easier</button>
        <button type="button" id="pause-btn">Pause</button>
        <button type="button" id="skip-btn">Alternate</button>
      </div>
      <div class="movement-nav">
        <button type="button" id="previous-btn">Previous</button>
        <button type="button" id="restart-btn">Restart</button>
        <button type="button" id="next-btn">Next</button>
      </div>
      <div class="player-exit-row">
        <button type="button" class="session-exit-btn" id="session-exit-btn" hidden>End session</button>
      </div>
    </div>
  `);

  document.getElementById("easier-btn").addEventListener("click", toggleEasier);
  document.getElementById("pause-btn").addEventListener("click", togglePause);
  document.getElementById("skip-btn").addEventListener("click", skipMovement);
  document.getElementById("previous-btn").addEventListener("click", previousMovement);
  document.getElementById("restart-btn").addEventListener("click", restartMovement);
  document.getElementById("next-btn").addEventListener("click", nextMovement);
  document.getElementById("session-exit-btn").addEventListener("click", handleSessionExit);
}

function variantFor(movement) {
  if (alternateVersion && movement.altLabel) {
    return {
      label: movement.altLabel,
      cue: movement.altCue || movement.cue,
      demo: movement.altDemo || null,
      badge: "ALTERNATE"
    };
  }
  if (easier && movement.easierLabel) {
    return {
      label: movement.easierLabel,
      cue: movement.easierCue || movement.cue,
      demo: movement.easierDemo || movement.demo || null,
      badge: "EASIER"
    };
  }
  return {
    label: movement.label,
    cue: movement.cue,
    demo: movement.demo,
    badge: "STANDARD"
  };
}

function renderStageMedia(movement, variant) {
  const stage = document.getElementById("stage-demo");
  if (!stage) return;
  if (variant.demo) {
    const src = escapeHtml(variant.demo);
    if (variant.demo.includes("/media/motion.html") || variant.demo.includes("/media/showcase.html")) {
      stage.innerHTML = `<iframe class="movement-frame" src="${src}" title="${escapeHtml(variant.label)} demonstration" loading="eager"></iframe>`;
    } else if (/\.svg(?:\?|$)/i.test(variant.demo)) {
      stage.innerHTML = `<img class="movement-animation" src="${src}" alt="${escapeHtml(variant.label)} demonstration">`;
    } else {
      stage.innerHTML = `<video class="movement-video" src="${src}" autoplay muted loop playsinline preload="auto"></video>`;
    }
    return;
  }
  stage.innerHTML = `
    <div class="equipment-mark" aria-hidden="true"><span></span><span></span><span></span></div>
    <div class="demo-kicker">MOVEMENT DEMO</div>
    <div class="demo-copy">${escapeHtml(variant.label)}<br><span style="color:#747b7e">Animation pending</span></div>
  `;
}

function updatePlayerUI() {
  const meta = document.getElementById("player-meta");
  if (!meta) return;

  const totalSeconds = totalSessionSeconds() || duration * 60;
  const plannedPosition = plannedPositionSeconds();
  const overallRemaining = Math.max(0, totalSeconds - plannedPosition);
  const progress = Math.min(100, (plannedPosition / totalSeconds) * 100);
  const movement = sequence[currentIndex];
  const pauseBtn = document.getElementById("pause-btn");
  const exitBtn = document.getElementById("session-exit-btn");
  const pauseOverlay = document.getElementById("pause-overlay");
  const timer = document.getElementById("movement-timer");
  const previousBtn = document.getElementById("previous-btn");
  const restartBtn = document.getElementById("restart-btn");
  const nextBtn = document.getElementById("next-btn");
  if (pauseBtn) pauseBtn.disabled = false;
  if (exitBtn) {
    exitBtn.hidden = true;
    exitBtn.textContent = "End session";
  }

  document.getElementById("progress-fill").style.width = progress + "%";
  document.getElementById("overall-remaining").textContent = formatTime(overallRemaining);
  document.getElementById("pause-btn").textContent = paused ? "Resume" : "Pause";
  if (pauseOverlay) pauseOverlay.hidden = !paused;
  if (timer) timer.classList.toggle("timer-urgent", (phase === "work" || phase === "transition") && phaseSeconds <= 3 && !paused);
  if (previousBtn) previousBtn.disabled = phase !== "work" || paused || currentIndex <= 0;
  if (restartBtn) restartBtn.disabled = phase !== "work" || paused;
  if (nextBtn) nextBtn.disabled = phase !== "work" || paused || currentIndex >= sequence.length - 1;

  if (phase === "prestart") {
    meta.textContent = `${duration} MIN · ${run.equipment_label}`;
    document.getElementById("movement-timer").innerHTML = `<strong>${phaseSeconds}</strong>`;
    document.getElementById("movement-title").textContent = "Get ready";
    document.getElementById("movement-cue").textContent = "Set your equipment. Make sure you have clear space.";
    document.getElementById("stage-demo").innerHTML = `<div class="demo-kicker">STARTING</div><div class="demo-copy">Your session begins in a moment.</div>`;
    document.getElementById("stage-badge").textContent = "READY";
    document.getElementById("easier-btn").textContent = "Easier";
    if (pauseBtn) pauseBtn.disabled = true;
    if (exitBtn) {
      exitBtn.hidden = false;
      exitBtn.textContent = "Cancel";
    }
    setControlsDisabled(true);
    return;
  }

  if (phase === "transition") {
    const next = sequence[currentIndex + 1];
    meta.textContent = `${currentIndex + 1} / ${sequence.length} COMPLETE`;
    document.getElementById("movement-timer").innerHTML = `<strong>${phaseSeconds}</strong><small>NEXT</small>`;
    document.getElementById("movement-title").textContent = `Next: ${next.label}`;
    document.getElementById("movement-cue").textContent = "Get ready. Keep the same equipment.";
    renderStageMedia(next, { label: next.label, cue: next.cue, demo: next.demo, badge: "NEXT" });
    document.getElementById("stage-badge").textContent = "NEXT";
    document.getElementById("easier-btn").textContent = "Easier";
    if (exitBtn) exitBtn.hidden = !paused;
    setControlsDisabled(true);
    return;
  }

  const variant = variantFor(movement);
  meta.textContent = `${currentIndex + 1} / ${sequence.length} · ${run.equipment_label}`;
  document.getElementById("movement-timer").innerHTML = `<strong>${phaseSeconds}</strong><small>SEC</small>`;
  document.getElementById("movement-title").textContent = variant.label;
  document.getElementById("movement-cue").textContent = variant.cue || "Move with control.";
  document.getElementById("stage-badge").textContent = variant.badge;
  document.getElementById("easier-btn").textContent = easier ? "Standard" : "Easier";
  renderStageMedia(movement, variant);
  if (exitBtn) exitBtn.hidden = !paused;

  const easierBtn = document.getElementById("easier-btn");
  const skipBtn = document.getElementById("skip-btn");
  easierBtn.disabled = !movement.easierLabel || alternateVersion > 0;
  skipBtn.disabled = !movement.altLabel || alternateVersion > 0;
}

function setControlsDisabled(disabled) {
  ["easier-btn", "skip-btn"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.disabled = disabled;
  });
}

function toggleEasier() {
  if (phase !== "work") return;
  const movement = sequence[currentIndex];
  if (!movement.easierLabel || alternateVersion) return;
  easier = !easier;
  updatePlayerUI();
}

function togglePause() {
  if (phase === "prestart") return;
  paused = !paused;
  updatePlayerUI();
}

function previousMovement() {
  if (phase !== "work" || paused || currentIndex <= 0) return;
  beginMovement(currentIndex - 1);
}

function restartMovement() {
  if (phase !== "work" || paused) return;
  phaseSeconds = sequence[currentIndex].seconds;
  easier = false;
  alternateVersion = 0;
  vibrate(30);
  updatePlayerUI();
}

function nextMovement() {
  if (phase !== "work" || paused || currentIndex >= sequence.length - 1) return;
  const current = sequence[currentIndex];
  if (!run?.showcase_demo) {
    api("movement_skipped", {
      run_id: run.run_id,
      movement_index: currentIndex + 1,
      movement_label: current.label
    }).catch(() => {});
  }
  beginTransition();
}

async function handleSessionExit() {
  if (phase === "prestart") {
    if (run?.showcase_demo) {
      leaveShowcase();
      return;
    }
    clearPlayerTimer();
    phase = "idle";
    sessionStartLogged = false;
    await releaseWakeLock();
    document.body.classList.remove("session-mode");
    renderReady();
    return;
  }

  if (!paused || !["work", "transition"].includes(phase)) return;
  if (!confirm("End this MOVA session? Your completed movement time will still be saved.")) return;

  clearPlayerTimer();
  await releaseWakeLock();

  if (run?.showcase_demo) {
    leaveShowcase();
    return;
  }

  try {
    await api("session_stopped", {
      run_id: run.run_id,
      elapsed_seconds: elapsedSeconds
    });
  } catch (error) {
    showError(error.message);
    return;
  }

  sessionStartLogged = false;
  phase = "complete";
  document.body.classList.remove("session-mode");
  renderStopped();
}

async function renderStopped() {
  await refreshProgress();
  render(`
    <div class="eyebrow">MOVA</div>
    <h1>Session ended.</h1>
    <p class="lead">${formatTime(elapsedSeconds)} of movement time was saved.</p>
    ${progressCardsHtml()}
    <div class="action-stack">
      <button class="primary-btn" id="again-after-stop">Choose another session</button>
      <button class="secondary-btn" id="progress-after-stop">My progress</button>
    </div>
  `);
  document.getElementById("again-after-stop").addEventListener("click", renderTime);
  document.getElementById("progress-after-stop").addEventListener("click", renderProgress);
}

function skipMovement() {
  if (phase !== "work") return;
  const current = sequence[currentIndex];
  if (!current.altLabel || alternateVersion) return;

  if (!run?.showcase_demo) {
    api("movement_skipped", {
      run_id: run.run_id,
      movement_index: currentIndex + 1,
      movement_label: current.label
    }).catch(() => {});
  }

  alternateVersion = 1;
  easier = false;
  vibrate(30);
  updatePlayerUI();
}

async function completeSession() {
  clearPlayerTimer();
  phase = "complete";
  if (!elapsedSeconds) elapsedSeconds = totalSessionSeconds() || duration * 60;
  updatePlayerUI();
  await releaseWakeLock();

  if (run?.showcase_demo) {
    document.body.classList.remove("session-mode");
    renderShowcaseCompletion();
    return;
  }

  try {
    await api("session_completed", {
      run_id: run.run_id,
      elapsed_seconds: elapsedSeconds
    });
  } catch (_) {}

  await refreshProgress();
  document.body.classList.remove("session-mode");
  renderCompletion();
}

function renderShowcaseCompletion() {
  render(`
    <div class="showcase-complete">
      <div class="eyebrow">Visual showcase</div>
      <div class="completion-time">3:00</div>
      <div class="completion-label">DEMO COMPLETE</div>
      <h1>That’s the potential.</h1>
      <p class="lead">This showcase uses the real MOVA player and session flow with concept exercise visuals. It is not recorded in MOVA analytics.</p>
      <div class="showcase-note">
        <strong>Production direction</strong>
        <span>The finished library can replace these concept visuals with the final consistent MOVA presenter clips without changing the player experience.</span>
      </div>
      <div class="action-stack">
        <button class="primary-btn" id="showcase-again">Run showcase again</button>
        <button class="secondary-btn" id="showcase-back">Back to real session</button>
      </div>
    </div>
  `);

  document.getElementById("showcase-again").addEventListener("click", () => {
    run = buildShowcaseRun();
    goal = "whole_body";
    startSession();
  });
  document.getElementById("showcase-back").addEventListener("click", leaveShowcase);
}

function renderCompletion() {
  const week = progressSummary?.week || {};
  render(`
    <div class="completion-hero">
      <div class="eyebrow">Session complete</div>
      <div class="completion-time">${formatTime(elapsedSeconds)}</div>
      <div class="completion-label">MOVED</div>
      <h1>Nice work.</h1>
      <p class="lead">${escapeHtml(goalLabel(goal))} · ${escapeHtml(run.equipment_label)}</p>
    </div>
    ${progressCardsHtml()}
    <div class="completion-week">You're at <strong>${Number(week.movement_minutes || 0)} movement minutes</strong> this week.</div>
    <div class="feedback-section">
      <div class="feedback-title">How did that session feel?</div>
      <div class="feedback-grid">
        <button class="feedback-btn" data-feedback="too_easy">Too easy</button>
        <button class="feedback-btn primary-btn" data-feedback="about_right">About right</button>
        <button class="feedback-btn" data-feedback="too_hard">Too hard</button>
      </div>
    </div>
  `);

  bind("[data-feedback]", async (event) => {
    const feedback = event.currentTarget.dataset.feedback;
    try { await api("feedback", { run_id: run.run_id, feedback }); } catch (_) {}
    renderDone();
  });
}

function renderDone() {
  const week = progressSummary?.week || {};
  render(`
    <div class="eyebrow">MOVA</div>
    <h1>Done.</h1>
    <p class="lead">You've logged ${Number(week.sessions || 0)} session${Number(week.sessions || 0) === 1 ? "" : "s"} and ${Number(week.movement_minutes || 0)} movement minutes this week.</p>
    <div class="action-stack">
      <button class="primary-btn" id="again">Move again</button>
      <button class="secondary-btn" id="done-progress">My progress</button>
      <button class="text-btn" id="done-home">Home</button>
    </div>
  `);
  document.getElementById("again").addEventListener("click", renderTime);
  document.getElementById("done-progress").addEventListener("click", renderProgress);
  document.getElementById("done-home").addEventListener("click", renderHome);
}

function formatTime(seconds) {
  const m = Math.floor(seconds / 60);
  const s = String(seconds % 60).padStart(2, "0");
  return `${m}:${s}`;
}

function vibrate(pattern) {
  if ("vibrate" in navigator) navigator.vibrate(pattern);
}

function clearPlayerTimer() {
  if (timerId) clearInterval(timerId);
  timerId = null;
}

function resetPlayerState() {
  clearPlayerTimer();
  phase = "idle";
  sequence = [];
  currentIndex = 0;
  elapsedSeconds = 0;
  phaseSeconds = 0;
  paused = false;
  easier = false;
  alternateVersion = 0;
  sessionStartLogged = false;
  releaseWakeLock();
}

async function requestWakeLock() {
  if (!("wakeLock" in navigator)) return;
  try { wakeLock = await navigator.wakeLock.request("screen"); } catch (_) {}
}

async function releaseWakeLock() {
  try { if (wakeLock) await wakeLock.release(); } catch (_) {}
  wakeLock = null;
}

document.addEventListener("visibilitychange", async () => {
  if (document.hidden && (phase === "work" || phase === "transition")) {
    paused = true;
    updatePlayerUI();
  } else if (!document.hidden && phase !== "idle" && phase !== "complete") {
    await requestWakeLock();
  }
});

registerPwa();
boot();
