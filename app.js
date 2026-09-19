const API = "https://nslfyglqamrhbqfdwftr.supabase.co/functions/v1/mova-scan";
const app = document.getElementById("app");
const footer = document.getElementById("kit-footer");
const params = new URLSearchParams(location.search);
const token = params.get("t");

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

const deviceId = getDeviceId();

function getDeviceId() {
  let id = localStorage.getItem("mova_device_id");
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem("mova_device_id", id);
  }
  return id;
}

async function api(action, payload = {}) {
  const response = await fetch(API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token, device_id: deviceId, action, ...payload })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "MOVA could not complete that request.");
  return data;
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
  return String(value).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}

async function boot() {
  if (!token) return showError("No MOVA kit token was found in this link.");
  render(`<div class="loader-wrap"><div class="loader"></div><div>Opening your MOVA kit…</div></div>`);
  try {
    const data = await api("scan");
    kit = data.kit;
    footer.textContent = `${kit.code} · MOVA`;
    renderTime();
  } catch (error) {
    showError(error.message);
  }
}

function renderTime() {
  resetPlayerState();
  document.body.classList.remove("session-mode");
  render(`
    <div class="safety"><span class="safety-dot"></span>Parked. Secure. Clear. Free to move.</div>
    <h1>How much time have you got?</h1>
    <p class="lead">Pick the time. MOVA handles the rest.</p>
    <div class="time-grid">
      <button class="time-btn" data-time="3">3<span>MIN</span></button>
      <button class="time-btn recommended" data-time="5">5<span>MIN</span></button>
      <button class="time-btn" data-time="10">10<span>MIN</span></button>
    </div>
  `);

  bind("[data-time]", (event) => {
    duration = Number(event.currentTarget.dataset.time);
    api("select_time", { duration }).catch(() => {});
    renderGoal();
  });
}

function renderGoal() {
  render(`
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

function renderReady() {
  const goalTitle = {
    loosen_up: "Loosen Up",
    get_moving: "Get Moving",
    get_stronger: "Get Stronger",
    whole_body: "Whole Body"
  }[goal];

  render(`
    <div class="eyebrow">${duration} min · ${goalTitle}</div>
    <h1>Your session is ready.</h1>
    <p class="lead">One tool. No swapping. Start when you're ready.</p>
    <div class="card">
      <div class="card-label">Selected equipment</div>
      <div class="equipment-name">${escapeHtml(run.equipment_label)}</div>
      <div class="session-title">${escapeHtml(run.title)}</div>
      <div class="session-meta">
        <span class="pill">${duration} min</span>
        <span class="pill">Level ${run.level}</span>
        <span class="pill">One tool</span>
      </div>
    </div>
    <div class="action-stack">
      <button class="primary-btn" id="start-session">Start session</button>
      <button class="secondary-btn" id="change-session">Change selection</button>
    </div>
  `);

  document.getElementById("start-session").addEventListener("click", startSession);
  document.getElementById("change-session").addEventListener("click", renderTime);
}

function buildSequence(minutes) {
  const count = minutes === 3 ? 3 : minutes === 5 ? 4 : 6;
  const transitionCount = count - 1;
  const transitionSeconds = 3;
  const activeTotal = (minutes * 60) - (transitionCount * transitionSeconds);
  const base = Math.floor(activeTotal / count);
  let remainder = activeTotal - (base * count);

  return Array.from({ length: count }, (_, i) => ({
    id: i + 1,
    label: `Movement ${String(i + 1).padStart(2, "0")}`,
    altLabel: `Alternate ${String(i + 1).padStart(2, "0")}`,
    seconds: base + (remainder-- > 0 ? 1 : 0)
  }));
}

async function startSession() {
  try {
    await api("session_started", { run_id: run.run_id });
    sequence = buildSequence(duration);
    currentIndex = 0;
    elapsedSeconds = 0;
    paused = false;
    easier = false;
    alternateVersion = 0;
    document.body.classList.add("session-mode");
    await requestWakeLock();
    startPreCountdown();
  } catch (error) {
    showError(error.message);
  }
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
  phase = "transition";
  phaseSeconds = 3;
  easier = false;
  vibrate([40, 35, 40]);
  updatePlayerUI();
}

function tickPlayer() {
  if (paused) return;

  if (phase === "prestart") {
    phaseSeconds -= 1;
    if (phaseSeconds <= 0) {
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
    <div class="player">
      <div class="player-top">
        <span id="player-meta"></span>
        <span id="overall-remaining"></span>
      </div>
      <div class="progress"><div id="progress-fill"></div></div>

      <div class="player-stage equipment-${escapeHtml(run.equipment)}" id="player-stage">
        <div class="timer" id="movement-timer"></div>
        <div class="stage-demo" id="stage-demo">
          <div class="equipment-mark" aria-hidden="true">
            <span></span><span></span><span></span>
          </div>
          <div class="demo-kicker" id="demo-kicker">PLAYER PROTOTYPE</div>
          <div class="demo-copy" id="demo-copy">Movement demo will play here.</div>
        </div>
        <div class="stage-badge" id="stage-badge">STANDARD</div>
      </div>

      <div>
        <div class="player-title" id="movement-title"></div>
        <div class="player-cue" id="movement-cue"></div>
      </div>

      <div class="player-controls">
        <button type="button" id="easier-btn">Easier</button>
        <button type="button" id="pause-btn">Pause</button>
        <button type="button" id="skip-btn">Skip</button>
      </div>
    </div>
  `);

  document.getElementById("easier-btn").addEventListener("click", toggleEasier);
  document.getElementById("pause-btn").addEventListener("click", togglePause);
  document.getElementById("skip-btn").addEventListener("click", skipMovement);
}

function updatePlayerUI() {
  const meta = document.getElementById("player-meta");
  if (!meta) return;

  const totalSeconds = duration * 60;
  const overallRemaining = Math.max(0, totalSeconds - elapsedSeconds);
  const progress = Math.min(100, (elapsedSeconds / totalSeconds) * 100);
  const movement = sequence[currentIndex];

  document.getElementById("progress-fill").style.width = progress + "%";
  document.getElementById("overall-remaining").textContent = formatTime(overallRemaining);
  document.getElementById("pause-btn").textContent = paused ? "Resume" : "Pause";
  document.getElementById("easier-btn").textContent = easier ? "Standard" : "Easier";

  if (phase === "prestart") {
    meta.textContent = `${duration} MIN · ${run.equipment_label}`;
    document.getElementById("movement-timer").innerHTML = `<strong>${phaseSeconds}</strong>`;
    document.getElementById("movement-title").textContent = "Get ready";
    document.getElementById("movement-cue").textContent = "Set your equipment. Make sure you have clear space.";
    document.getElementById("demo-kicker").textContent = "STARTING";
    document.getElementById("demo-copy").textContent = "Your session begins in a moment.";
    document.getElementById("stage-badge").textContent = "READY";
    setControlsDisabled(true);
    return;
  }

  if (phase === "transition") {
    const next = sequence[currentIndex + 1];
    meta.textContent = `${currentIndex + 1} / ${sequence.length} COMPLETE`;
    document.getElementById("movement-timer").innerHTML = `<strong>${phaseSeconds}</strong><small>NEXT</small>`;
    document.getElementById("movement-title").textContent = "Next up";
    document.getElementById("movement-cue").textContent = next.label;
    document.getElementById("demo-kicker").textContent = "TRANSITION";
    document.getElementById("demo-copy").textContent = "Keep the same equipment. No swapping.";
    document.getElementById("stage-badge").textContent = "NEXT";
    setControlsDisabled(true);
    return;
  }

  setControlsDisabled(false);
  const displayLabel = alternateVersion ? movement.altLabel : movement.label;
  meta.textContent = `${currentIndex + 1} / ${sequence.length} · ${run.equipment_label}`;
  document.getElementById("movement-timer").innerHTML = `<strong>${phaseSeconds}</strong><small>SEC</small>`;
  document.getElementById("movement-title").textContent = displayLabel;
  document.getElementById("movement-cue").textContent = easier
    ? "Easier option active. Keep the movement comfortable and controlled."
    : "Standard option. Follow the demo and move with control.";
  document.getElementById("demo-kicker").textContent = "MOVEMENT DEMO";
  document.getElementById("demo-copy").textContent = alternateVersion
    ? "Alternate movement will replace the original here."
    : "Final exercise video will play here.";
  document.getElementById("stage-badge").textContent = easier ? "EASIER" : "STANDARD";
}

function setControlsDisabled(disabled) {
  ["easier-btn", "skip-btn"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.disabled = disabled;
  });
}

function toggleEasier() {
  if (phase !== "work") return;
  easier = !easier;
  updatePlayerUI();
}

function togglePause() {
  if (phase === "prestart") return;
  paused = !paused;
  updatePlayerUI();
}

function skipMovement() {
  if (phase !== "work") return;
  const current = sequence[currentIndex];
  api("movement_skipped", {
    run_id: run.run_id,
    movement_index: currentIndex + 1,
    movement_label: alternateVersion ? current.altLabel : current.label
  }).catch(() => {});

  alternateVersion += 1;
  easier = false;
  vibrate(30);
  updatePlayerUI();
}

async function completeSession() {
  clearPlayerTimer();
  phase = "complete";
  elapsedSeconds = duration * 60;
  updatePlayerUI();
  await releaseWakeLock();

  try {
    await api("session_completed", {
      run_id: run.run_id,
      elapsed_seconds: elapsedSeconds
    });
  } catch (_) {}

  document.body.classList.remove("session-mode");
  renderFeedback();
}

function renderFeedback() {
  render(`
    <div class="eyebrow">Done</div>
    <h1>${duration} minutes complete.</h1>
    <p class="lead">How did that session feel?</p>
    <div class="feedback-grid">
      <button class="feedback-btn" data-feedback="too_easy">Too easy</button>
      <button class="feedback-btn primary-btn" data-feedback="about_right">About right</button>
      <button class="feedback-btn" data-feedback="too_hard">Too hard</button>
    </div>
  `);

  bind("[data-feedback]", async (event) => {
    const feedback = event.currentTarget.dataset.feedback;
    try { await api("feedback", { run_id: run.run_id, feedback }); } catch (_) {}
    renderDone();
  });
}

function renderDone() {
  render(`
    <div class="eyebrow">MOVA</div>
    <h1>Done.</h1>
    <p class="lead">Your feedback helps MOVA choose better sessions next time.</p>
    <button class="primary-btn" id="again">Move again</button>
  `);
  document.getElementById("again").addEventListener("click", renderTime);
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
  releaseWakeLock();
}

async function requestWakeLock() {
  if (!("wakeLock" in navigator)) return;
  try {
    wakeLock = await navigator.wakeLock.request("screen");
  } catch (_) {}
}

async function releaseWakeLock() {
  try {
    if (wakeLock) await wakeLock.release();
  } catch (_) {}
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

boot();
