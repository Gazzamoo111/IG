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
  return String(value ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
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

function renderReady() {
  const goalTitle = {
    loosen_up: "Loosen Up",
    get_moving: "Get Moving",
    get_stronger: "Get Stronger",
    whole_body: "Whole Body"
  }[goal];

  const stepCount = Array.isArray(run.steps) && run.steps.length ? run.steps.length : null;

  render(`
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
      <button class="secondary-btn" id="change-session">Change time or equipment</button>
      <button class="text-btn" id="change-goal">Change goal</button>
    </div>
  `);

  document.getElementById("start-session").addEventListener("click", startSession);
  document.getElementById("change-session").addEventListener("click", renderSessionOptions);
  document.getElementById("change-goal").addEventListener("click", renderGoal);
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

async function startSession() {
  try {
    await api("session_started", { run_id: run.run_id });
    sequence = sequenceFromRun();
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
        <div class="stage-demo" id="stage-demo"></div>
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
    if (variant.demo.includes("/media/motion.html")) {
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
  const overallRemaining = Math.max(0, totalSeconds - elapsedSeconds);
  const progress = Math.min(100, (elapsedSeconds / totalSeconds) * 100);
  const movement = sequence[currentIndex];

  document.getElementById("progress-fill").style.width = progress + "%";
  document.getElementById("overall-remaining").textContent = formatTime(overallRemaining);
  document.getElementById("pause-btn").textContent = paused ? "Resume" : "Pause";

  if (phase === "prestart") {
    meta.textContent = `${duration} MIN · ${run.equipment_label}`;
    document.getElementById("movement-timer").innerHTML = `<strong>${phaseSeconds}</strong>`;
    document.getElementById("movement-title").textContent = "Get ready";
    document.getElementById("movement-cue").textContent = "Set your equipment. Make sure you have clear space.";
    document.getElementById("stage-demo").innerHTML = `<div class="demo-kicker">STARTING</div><div class="demo-copy">Your session begins in a moment.</div>`;
    document.getElementById("stage-badge").textContent = "READY";
    document.getElementById("easier-btn").textContent = "Easier";
    setControlsDisabled(true);
    return;
  }

  if (phase === "transition") {
    const next = sequence[currentIndex + 1];
    meta.textContent = `${currentIndex + 1} / ${sequence.length} COMPLETE`;
    document.getElementById("movement-timer").innerHTML = `<strong>${phaseSeconds}</strong><small>NEXT</small>`;
    document.getElementById("movement-title").textContent = "Next up";
    document.getElementById("movement-cue").textContent = next.label;
    document.getElementById("stage-demo").innerHTML = `<div class="demo-kicker">TRANSITION</div><div class="demo-copy">Keep the same equipment. No swapping.</div>`;
    document.getElementById("stage-badge").textContent = "NEXT";
    document.getElementById("easier-btn").textContent = "Easier";
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

function skipMovement() {
  if (phase !== "work") return;
  const current = sequence[currentIndex];
  if (!current.altLabel || alternateVersion) return;

  api("movement_skipped", {
    run_id: run.run_id,
    movement_index: currentIndex + 1,
    movement_label: current.label
  }).catch(() => {});

  alternateVersion = 1;
  easier = false;
  vibrate(30);
  updatePlayerUI();
}

async function completeSession() {
  clearPlayerTimer();
  phase = "complete";
  elapsedSeconds = totalSessionSeconds() || duration * 60;
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

boot();
