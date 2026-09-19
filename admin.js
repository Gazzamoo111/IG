const READ_API="https://nslfyglqamrhbqfdwftr.supabase.co/functions/v1/mova-console?key=mova_console_demo_v1&mode=admin";
const WRITE_API="https://nslfyglqamrhbqfdwftr.supabase.co/functions/v1/mova-console";
const root=document.getElementById("admin-app");

let data=null;
let tab="overview";
let contentMode="sessions";
let sessionFilter={duration:"all",equipment:"all",goal:"all"};
let builderSession=null;
let movementEditor=null;

const labelGoal=g=>({loosen_up:"Loosen Up",get_moving:"Get Moving",get_stronger:"Get Stronger",whole_body:"Whole Body"}[g]||g);
const labelEquipment=e=>({bar:"MOVA Bar",handle_band:"Handle Band",mini_band:"Mini Band",bodyweight:"Bodyweight"}[e]||e);
const esc=v=>String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));

document.querySelectorAll("[data-tab]").forEach(b=>b.addEventListener("click",()=>{
  tab=b.dataset.tab;
  document.querySelectorAll("[data-tab]").forEach(x=>x.classList.toggle("active",x===b));
  builderSession=null;
  movementEditor=null;
  render();
}));

async function loadData(){
  const r=await fetch(READ_API);
  const d=await r.json();
  if(!r.ok) throw new Error(d.error||"Unable to load admin");
  data=d;
}

async function boot(){
  try{await loadData();render()}
  catch(e){root.className="";root.innerHTML=`<div class="notice">${esc(e.message)}</div>`}
}

function adminKey(){return sessionStorage.getItem("mova_admin_key")||""}

async function ensureAdminKey(){
  let key=adminKey();
  if(key) return key;
  key=prompt("Enter the MOVA prototype builder key");
  if(!key) throw new Error("Builder key required");
  const r=await fetch(WRITE_API,{
    method:"POST",
    headers:{"Content-Type":"application/json","x-mova-admin-key":key},
    body:JSON.stringify({action:"verify_admin"})
  });
  const d=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(d.error||"Invalid builder key");
  sessionStorage.setItem("mova_admin_key",key);
  return key;
}

async function adminPost(payload){
  const key=await ensureAdminKey();
  let r=await fetch(WRITE_API,{
    method:"POST",
    headers:{"Content-Type":"application/json","x-mova-admin-key":key},
    body:JSON.stringify(payload)
  });
  let d=await r.json().catch(()=>({}));
  if(r.status===401){
    sessionStorage.removeItem("mova_admin_key");
    throw new Error("Builder key expired or invalid");
  }
  if(!r.ok) throw new Error(d.error||"Admin save failed");
  return d;
}

function header(title,sub,button=""){
  const unlocked=!!adminKey();
  return `<div class="admin-header"><div><div class="eyebrow">MOVA Admin</div><h1>${esc(title)}</h1><div class="sub">${esc(sub)}</div></div>
  <div class="admin-header-actions">${button}<button class="btn ${unlocked?"":"primary"}" id="builder-lock-btn">${unlocked?"Builder unlocked":"Unlock builder"}</button></div></div>
  <div class="notice" style="margin-top:18px">Prototype content is editable here. Hardware-based movements still require physical kit validation before pilot release.</div>`;
}

function bindHeader(){
  const btn=document.getElementById("builder-lock-btn");
  if(!btn)return;
  btn.addEventListener("click",async()=>{
    if(adminKey()){
      sessionStorage.removeItem("mova_admin_key");
      render();
      return;
    }
    try{await ensureAdminKey();render()}catch(e){alert(e.message)}
  });
}

function smallMetric(label,value,note=""){
  return `<div class="metric"><div class="metric-label">${esc(label)}</div><div class="metric-value">${esc(value)}</div><div class="metric-note">${esc(note)}</div></div>`;
}

function render(){
  if(!data)return;
  root.className="";
  if(tab==="overview") overview();
  else if(tab==="fleets") fleets();
  else if(tab==="kits") kits();
  else if(tab==="content") content();
  else if(tab==="equipment") equipment();
  else analytics();
  bindHeader();
}

function overview(){
  const s=data.summary;
  root.innerHTML=header("Control centre","Manage MOVA rollout, hardware and content from one place.")+
  `<div class="cards">
    ${smallMetric("Fleets",s.fleets)}
    ${smallMetric("Kits",s.kits)}
    ${smallMetric("Ready sessions",s.ready_sessions)}
    ${smallMetric("Movements",s.movement_records)}
  </div>
  <section class="section"><div class="grid-2">
    <div class="panel"><div class="panel-title">Product build</div><div class="mix-list">
      ${statusRow("Driver scanner",100)}
      ${statusRow("Session player",100)}
      ${statusRow("Movement library",100)}
      ${statusRow("Session builder",100)}
      ${statusRow("Fleet console",90)}
    </div></div>
    <div class="panel"><div class="panel-title">Remaining production gates</div>
      <div class="panel-sub">These are validation and production tasks, not missing product architecture.</div>
      <div class="notice" style="margin-top:18px">Physical kit validation → movement filming → offline/PWA cache → secure account auth → live fleet pilot.</div>
    </div>
  </div></section>`;
}
function statusRow(name,value){return `<div class="mix-row"><div class="mix-name">${name}</div><div class="mix-track"><div class="mix-fill" style="width:${value}%"></div></div><div class="mix-value">${value}%</div></div>`}

function fleets(){
  root.innerHTML=header("Fleets","Companies, pilots and rollout status.",`<button class="btn primary" disabled>New fleet</button>`)+
  `<section class="section"><div class="panel table-wrap"><table><thead><tr><th>Fleet</th><th>Slug</th><th>Status</th><th>Sites</th></tr></thead><tbody>
  ${data.fleets.map(f=>`<tr><td><strong>${esc(f.name)}</strong></td><td>${esc(f.slug)}</td><td><span class="status live">${esc(f.status)}</span></td><td>Managed in MOVA</td></tr>`).join("")}
  </tbody></table></div></section>`;
}

function kits(){
  root.innerHTML=header("Kits","QR identity and equipment availability.",`<button class="btn primary" disabled>Create kit</button>`)+
  `<section class="section"><div class="panel table-wrap"><table><thead><tr><th>Kit</th><th>Status</th><th>Bar</th><th>Handle Band</th><th>Mini Band</th></tr></thead><tbody>
  ${data.kits.map(k=>`<tr><td><strong>${esc(k.code)}</strong></td><td><span class="status live">${esc(k.status)}</span></td><td>${yes(k.equipment.bar)}</td><td>${yes(k.equipment.handle_band)}</td><td>${yes(k.equipment.mini_band)}</td></tr>`).join("")}
  </tbody></table></div></section>`;
}
function yes(v){return v?"✓":"—"}

function content(){
  root.innerHTML=header("Content","The complete MOVA v1 movement library and timed session system.",`<button class="btn primary" id="new-movement-btn">New movement</button>`)+
  `<div class="content-toolbar">
    <button class="tab-pill ${contentMode==="sessions"?"active":""}" data-content-mode="sessions">Sessions · ${data.sessions.length}</button>
    <button class="tab-pill ${contentMode==="movements"?"active":""}" data-content-mode="movements">Movements · ${data.movements.length}</button>
  </div>
  <div id="content-body"></div>`;

  bindHeader();
  document.querySelectorAll("[data-content-mode]").forEach(b=>b.addEventListener("click",()=>{
    contentMode=b.dataset.contentMode;
    builderSession=null;movementEditor=null;content();
  }));
  document.getElementById("new-movement-btn")?.addEventListener("click",()=>{
    movementEditor={code:"",equipment:"bar",name:"",short_cue:"",easier_name:"",easier_cue:"",movement_pattern:"",difficulty:1,setup_cue:"",space_requirement:"small",demo_asset_url:"",easier_demo_asset_url:"",video_brief:"",metadata:{product_stage:"prototype"}};
    contentMode="movements";content();
  });

  if(contentMode==="sessions") renderSessions();
  else renderMovements();
}

function renderSessions(){
  const host=document.getElementById("content-body");
  if(builderSession){host.innerHTML=sessionBuilderHtml();bindSessionBuilder();return;}

  const sessions=data.sessions.filter(s=>
    (sessionFilter.duration==="all"||String(s.duration_minutes)===sessionFilter.duration)&&
    (sessionFilter.equipment==="all"||s.equipment===sessionFilter.equipment)&&
    (sessionFilter.goal==="all"||s.goal===sessionFilter.goal)
  );

  host.innerHTML=`
  <section class="section">
    <div class="filter-row">
      <select id="filter-duration"><option value="all">All durations</option><option value="3">3 min</option><option value="5">5 min</option><option value="10">10 min</option></select>
      <select id="filter-equipment"><option value="all">All equipment</option><option value="bar">MOVA Bar</option><option value="handle_band">Handle Band</option><option value="mini_band">Mini Band</option><option value="bodyweight">Bodyweight</option></select>
      <select id="filter-goal"><option value="all">All goals</option><option value="loosen_up">Loosen Up</option><option value="get_moving">Get Moving</option><option value="get_stronger">Get Stronger</option><option value="whole_body">Whole Body</option></select>
    </div>
    <div class="session-grid">
      ${sessions.map(sessionCard).join("")}
    </div>
  </section>`;

  for(const [id,key] of [["filter-duration","duration"],["filter-equipment","equipment"],["filter-goal","goal"]]){
    const el=document.getElementById(id);el.value=sessionFilter[key];
    el.addEventListener("change",()=>{sessionFilter[key]=el.value;renderSessions()});
  }
  document.querySelectorAll("[data-session-code]").forEach(card=>card.addEventListener("click",()=>{
    const s=data.sessions.find(x=>x.code===card.dataset.sessionCode);
    builderSession=JSON.parse(JSON.stringify(s));
    renderSessions();
  }));
}

function sessionCard(s){
  const total=s.steps.reduce((n,x)=>n+Number(x.duration_seconds)+Number(x.transition_seconds),0);
  return `<button class="session-card" data-session-code="${esc(s.code)}">
    <div class="code">${esc(s.code)}</div>
    <h3>${esc(s.title)}</h3>
    <div class="tags">
      <span class="tag">${s.duration_minutes} min</span>
      <span class="tag">${esc(labelGoal(s.goal))}</span>
      <span class="tag">${esc(labelEquipment(s.equipment))}</span>
      <span class="tag approved">${esc(s.status)}</span>
    </div>
    <div class="session-card-foot"><span>${s.steps.length} steps</span><span>${formatTime(total)}</span></div>
  </button>`;
}

function sessionBuilderHtml(){
  const s=builderSession;
  const options=data.movements.filter(m=>m.active&&m.equipment===s.equipment);
  const total=s.steps.reduce((n,x)=>n+Number(x.duration_seconds)+Number(x.transition_seconds),0);
  const target=s.duration_minutes*60;
  return `
  <section class="section builder">
    <div class="builder-head">
      <button class="btn" id="builder-back">← Sessions</button>
      <div class="builder-total ${total===target?"good":"bad"}">Total ${formatTime(total)} / ${formatTime(target)}</div>
    </div>
    <div class="builder-meta">
      <label>Session title<input id="session-title" value="${esc(s.title)}"></label>
      <div class="builder-meta-readonly"><span>${esc(s.code)}</span><span>${s.duration_minutes} min</span><span>${esc(labelGoal(s.goal))}</span><span>${esc(labelEquipment(s.equipment))}</span></div>
    </div>
    <div class="builder-table">
      <div class="builder-row builder-row-head"><span>#</span><span>Movement</span><span>Work</span><span>Transition</span><span>Alternate</span><span></span></div>
      ${s.steps.map((step,i)=>builderRow(step,i,options)).join("")}
    </div>
    <div class="builder-actions">
      <button class="btn" id="add-step">Add movement</button>
      <button class="btn primary" id="save-session" ${total===target?"":"disabled"}>Save session</button>
    </div>
    <div class="notice">The session must total exactly ${s.duration_minutes}:00. The final step must have a 0-second transition.</div>
  </section>`;
}

function movementOptions(options,selected){
  return options.map(m=>`<option value="${esc(m.code)}" ${m.code===selected?"selected":""}>${esc(m.name)}</option>`).join("");
}
function alternateOptions(options,selected){
  return `<option value="">None</option>`+movementOptions(options,selected);
}
function builderRow(step,i,options){
  return `<div class="builder-row" data-step-index="${i}">
    <span class="step-num">${i+1}</span>
    <select data-field="movement_code">${movementOptions(options,step.movement_code)}</select>
    <input type="number" min="10" max="180" data-field="duration_seconds" value="${Number(step.duration_seconds)}">
    <input type="number" min="0" max="30" data-field="transition_seconds" value="${Number(step.transition_seconds)}">
    <select data-field="alternate_movement_code">${alternateOptions(options,step.alternate_movement_code||"")}</select>
    <div class="row-actions"><button type="button" data-up="1">↑</button><button type="button" data-down="1">↓</button><button type="button" data-remove="1">×</button></div>
  </div>`;
}

function syncBuilderFromDom(){
  const rows=[...document.querySelectorAll(".builder-row[data-step-index]")];
  builderSession.title=document.getElementById("session-title").value;
  builderSession.steps=rows.map((row,i)=>({
    ...(builderSession.steps[Number(row.dataset.stepIndex)]||{}),
    order:i+1,
    movement_code:row.querySelector('[data-field="movement_code"]').value,
    duration_seconds:Number(row.querySelector('[data-field="duration_seconds"]').value),
    transition_seconds:Number(row.querySelector('[data-field="transition_seconds"]').value),
    alternate_movement_code:row.querySelector('[data-field="alternate_movement_code"]').value||null
  }));
}

function bindSessionBuilder(){
  document.getElementById("builder-back").addEventListener("click",()=>{builderSession=null;renderSessions()});
  document.querySelectorAll(".builder-row[data-step-index] input,.builder-row[data-step-index] select").forEach(el=>el.addEventListener("change",()=>{syncBuilderFromDom();renderSessions()}));
  document.querySelectorAll("[data-up]").forEach(b=>b.addEventListener("click",()=>moveStep(Number(b.closest(".builder-row").dataset.stepIndex),-1)));
  document.querySelectorAll("[data-down]").forEach(b=>b.addEventListener("click",()=>moveStep(Number(b.closest(".builder-row").dataset.stepIndex),1)));
  document.querySelectorAll("[data-remove]").forEach(b=>b.addEventListener("click",()=>removeStep(Number(b.closest(".builder-row").dataset.stepIndex))));
  document.getElementById("add-step").addEventListener("click",()=>addStep());
  document.getElementById("save-session").addEventListener("click",saveSession);
}
function moveStep(i,dir){syncBuilderFromDom();const j=i+dir;if(j<0||j>=builderSession.steps.length)return;[builderSession.steps[i],builderSession.steps[j]]=[builderSession.steps[j],builderSession.steps[i]];renderSessions()}
function removeStep(i){syncBuilderFromDom();builderSession.steps.splice(i,1);if(builderSession.steps.length)builderSession.steps[builderSession.steps.length-1].transition_seconds=0;renderSessions()}
function addStep(){
  syncBuilderFromDom();
  const m=data.movements.find(x=>x.active&&x.equipment===builderSession.equipment);
  if(!m)return;
  if(builderSession.steps.length)builderSession.steps[builderSession.steps.length-1].transition_seconds=3;
  builderSession.steps.push({movement_code:m.code,duration_seconds:30,transition_seconds:0,alternate_movement_code:null});
  renderSessions();
}
async function saveSession(){
  syncBuilderFromDom();
  try{
    const btn=document.getElementById("save-session");btn.disabled=true;btn.textContent="Saving…";
    await adminPost({action:"save_session",session_code:builderSession.code,title:builderSession.title,steps:builderSession.steps});
    await loadData();
    builderSession=JSON.parse(JSON.stringify(data.sessions.find(x=>x.code===builderSession.code)));
    renderSessions();
  }catch(e){alert(e.message);renderSessions()}
}

function renderMovements(){
  const host=document.getElementById("content-body");
  if(movementEditor){host.innerHTML=movementEditorHtml();bindMovementEditor();return;}
  host.innerHTML=`<section class="section"><div class="movement-grid">${data.movements.filter(m=>m.active).map(movementCard).join("")}</div></section>`;
  document.querySelectorAll("[data-movement-code]").forEach(card=>card.addEventListener("click",()=>{
    const m=data.movements.find(x=>x.code===card.dataset.movementCode);
    movementEditor=JSON.parse(JSON.stringify(m));renderMovements();
  }));
}
function movementCard(m){
  return `<button class="movement-card" data-movement-code="${esc(m.code)}">
    <div class="code">${esc(m.code)}</div><h3>${esc(m.name)}</h3>
    <p>${esc(m.short_cue)}</p>
    <div class="tags"><span class="tag">${esc(labelEquipment(m.equipment))}</span><span class="tag">${esc(m.movement_pattern||"movement")}</span><span class="tag">L${m.difficulty}</span></div>
  </button>`;
}
function movementEditorHtml(){
  const m=movementEditor;
  return `<section class="section builder">
    <div class="builder-head"><button class="btn" id="movement-back">← Movement library</button><span class="tag approved">Prototype content</span></div>
    <div class="editor-grid">
      <label>Code<input id="mv-code" value="${esc(m.code)}" ${m.id?"readonly":""}></label>
      <label>Equipment<select id="mv-equipment">
        ${["bar","handle_band","mini_band","bodyweight"].map(x=>`<option value="${x}" ${m.equipment===x?"selected":""}>${labelEquipment(x)}</option>`).join("")}
      </select></label>
      <label>Name<input id="mv-name" value="${esc(m.name)}"></label>
      <label>Pattern<input id="mv-pattern" value="${esc(m.movement_pattern||"")}"></label>
      <label>Difficulty<select id="mv-difficulty">${[1,2,3].map(x=>`<option value="${x}" ${Number(m.difficulty)===x?"selected":""}>Level ${x}</option>`).join("")}</select></label>
      <label>Space<select id="mv-space">${["small","medium"].map(x=>`<option value="${x}" ${m.space_requirement===x?"selected":""}>${x}</option>`).join("")}</select></label>
      <label class="wide">Primary cue<textarea id="mv-cue">${esc(m.short_cue)}</textarea></label>
      <label>Easy version<input id="mv-easy-name" value="${esc(m.easier_name||"")}"></label>
      <label>Easy cue<input id="mv-easy-cue" value="${esc(m.easier_cue||"")}"></label>
      <label class="wide">Setup cue<textarea id="mv-setup">${esc(m.setup_cue||"")}</textarea></label>
      <label class="wide">Demo video URL<input id="mv-demo" value="${esc(m.demo_asset_url||"")}"></label>
      <label class="wide">Easier demo URL<input id="mv-easy-demo" value="${esc(m.easier_demo_asset_url||"")}"></label>
      <label class="wide">Filming brief<textarea id="mv-video-brief">${esc(m.video_brief||"")}</textarea></label>
    </div>
    <div class="builder-actions"><button class="btn primary" id="save-movement">Save movement</button></div>
  </section>`;
}
function bindMovementEditor(){
  document.getElementById("movement-back").addEventListener("click",()=>{movementEditor=null;renderMovements()});
  document.getElementById("save-movement").addEventListener("click",saveMovement);
}
async function saveMovement(){
  const payload={
    action:"save_movement",
    code:document.getElementById("mv-code").value,
    equipment:document.getElementById("mv-equipment").value,
    name:document.getElementById("mv-name").value,
    movement_pattern:document.getElementById("mv-pattern").value,
    difficulty:Number(document.getElementById("mv-difficulty").value),
    space_requirement:document.getElementById("mv-space").value,
    short_cue:document.getElementById("mv-cue").value,
    easier_name:document.getElementById("mv-easy-name").value,
    easier_cue:document.getElementById("mv-easy-cue").value,
    setup_cue:document.getElementById("mv-setup").value,
    demo_asset_url:document.getElementById("mv-demo").value,
    easier_demo_asset_url:document.getElementById("mv-easy-demo").value,
    video_brief:document.getElementById("mv-video-brief").value,
    metadata:movementEditor.metadata||{product_stage:"prototype"},
    active:true
  };
  try{
    const btn=document.getElementById("save-movement");btn.disabled=true;btn.textContent="Saving…";
    await adminPost(payload);await loadData();
    movementEditor=JSON.parse(JSON.stringify(data.movements.find(x=>x.code===payload.code.toUpperCase())));
    renderMovements();
  }catch(e){alert(e.message);renderMovements()}
}

function equipment(){
  root.innerHTML=header("Equipment","Prototype hardware specifications stored in MOVA.")+
  `<section class="section"><div class="equipment-specs">${data.equipment_specs.map(specCard).join("")}</div></section>`;
}
function specCard(s){
  const spec=s.spec||{};const entries=Object.entries(spec).slice(0,7);
  return `<div class="spec"><div class="eyebrow">V${s.version} · ${esc(s.status)}</div><h3>${esc(s.display_name)}</h3><dl>
  ${entries.map(([k,v])=>`<div><dt>${esc(k.replaceAll("_"," "))}</dt><dd>${esc(typeof v==="object"?JSON.stringify(v):String(v))}</dd></div>`).join("")}</dl></div>`;
}

function analytics(){
  root.innerHTML=header("Analytics","Internal product behaviour and pilot performance.")+
  `<section class="section"><div class="grid-2">
    <div class="panel"><div class="panel-title">Product events</div><div class="panel-sub">Scan, time choice, goal choice, session start, skip, completion and feedback are captured by the MOVA backend.</div></div>
    <div class="panel"><div class="panel-title">Content quality</div><div class="panel-sub">Skip behaviour and difficulty feedback can be used to identify sessions and movements that need review after field testing.</div></div>
  </div></section>`;
}

function formatTime(seconds){
  const s=Math.max(0,Math.round(Number(seconds)||0));
  return Math.floor(s/60)+":"+String(s%60).padStart(2,"0");
}

boot();