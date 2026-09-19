const API = "https://nslfyglqamrhbqfdwftr.supabase.co/functions/v1/mova-scan";
const app = document.getElementById("app");
const footer = document.getElementById("kit-footer");
const params = new URLSearchParams(location.search);
const token = params.get("t");

let kit = null;
let duration = null;
let goal = null;
let run = null;
let sessionStartedAt = null;

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

  bind("[data-time]", async (event) => {
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

async function startSession() {
  try {
    await api("session_started", { run_id: run.run_id });
    sessionStartedAt = Date.now();
    renderPlayer();
  } catch (error) {
    showError(error.message);
  }
}

function renderPlayer() {
  render(`
    <div class="player">
      <div class="player-top"><span>${duration} MIN · ${escapeHtml(run.equipment_label)}</span><span>1 / —</span></div>
      <div class="progress"><div></div></div>
      <div class="player-stage">
        <div class="timer">0:30</div>
        <div class="player-placeholder">
          <strong>Movement player</strong>
          Video, timer and movement cues are the next build.
        </div>
      </div>
      <div class="player-title">Session started</div>
      <div class="player-cue">The scanner and backend are now connected end-to-end.</div>
      <div class="player-controls">
        <button type="button">Easier</button>
        <button type="button">Pause</button>
        <button type="button">Skip</button>
      </div>
      <button class="primary-btn" id="complete-demo">Complete demo</button>
    </div>
  `);

  document.getElementById("complete-demo").addEventListener("click", completeDemo);
}

async function completeDemo() {
  const elapsed = sessionStartedAt ? Math.round((Date.now() - sessionStartedAt) / 1000) : 0;
  try {
    await api("session_completed", { run_id: run.run_id, elapsed_seconds: elapsed });
  } catch (_) {}
  renderFeedback();
}

function renderFeedback() {
  render(`
    <div class="eyebrow">Done</div>
    <h1>${duration} minutes complete.</h1>
    <p class="lead">How did that feel?</p>
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

boot();
