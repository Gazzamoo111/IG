const API="https://nslfyglqamrhbqfdwftr.supabase.co/functions/v1/mova-console?key=mova_console_demo_v1&mode=admin";
const root=document.getElementById("admin-app");let data=null;let tab="overview";
const labelGoal=g=>({loosen_up:"Loosen Up",get_moving:"Get Moving",get_stronger:"Get Stronger",whole_body:"Whole Body"}[g]||g);
const labelEquipment=e=>({bar:"MOVA Bar",handle_band:"Handle Band",mini_band:"Mini Band",bodyweight:"Bodyweight"}[e]||e);
document.querySelectorAll("[data-tab]").forEach(b=>b.addEventListener("click",()=>{tab=b.dataset.tab;document.querySelectorAll("[data-tab]").forEach(x=>x.classList.toggle("active",x===b));render()}));
async function boot(){try{const r=await fetch(API);data=await r.json();if(!r.ok)throw new Error(data.error||"Unable to load admin");render()}catch(e){root.className="";root.innerHTML=`<div class="notice">${e.message}</div>`}}
function header(title,sub,button){return `<div class="admin-header"><div><div class="eyebrow">MOVA Admin</div><h1>${title}</h1><div class="sub">${sub}</div></div>${button||""}</div>
<div class="notice" style="margin-top:18px">Read-only product prototype. Production write actions will require authenticated MOVA admin access.</div>`}
function smallMetric(label,value,note=""){return `<div class="metric"><div class="metric-label">${label}</div><div class="metric-value">${value}</div><div class="metric-note">${note}</div></div>`}
function render(){if(!data)return;root.className="";
 if(tab==="overview")return overview();if(tab==="fleets")return fleets();if(tab==="kits")return kits();if(tab==="content")return content();
 if(tab==="equipment")return equipment();analytics();
}
function overview(){const s=data.summary;root.innerHTML=header("Control centre","Manage MOVA rollout, hardware and content from one place.")+
 `<div class="cards">${smallMetric("Fleets",s.fleets)}${smallMetric("Kits",s.kits)}${smallMetric("3 min families",s.three_minute_families)}${smallMetric("Movements",s.movement_records,"Approved library later")}</div>
 <section class="section"><div class="grid-2"><div class="panel"><div class="panel-title">Build status</div><div class="mix-list">
 ${statusRow("Driver scanner",100)}${statusRow("Session player",100)}${statusRow("Content engine",85)}${statusRow("Fleet console",90)}${statusRow("Admin console",75)}
 </div></div><div class="panel"><div class="panel-title">Next production gates</div><div class="panel-sub">What converts the prototype into pilot-ready software.</div>
 <div class="notice" style="margin-top:18px">Admin authentication → real movement content → media upload → fleet reporting export → offline session cache → field testing.</div></div></div></section>`;
}
function statusRow(name,value){return `<div class="mix-row"><div class="mix-name">${name}</div><div class="mix-track"><div class="mix-fill" style="width:${value}%"></div></div><div class="mix-value">${value}%</div></div>`}
function fleets(){root.innerHTML=header("Fleets","Companies, pilots and rollout status.",`<button class="btn primary" disabled>New fleet</button>`)+
 `<section class="section"><div class="panel table-wrap"><table><thead><tr><th>Fleet</th><th>Slug</th><th>Status</th><th>Sites</th></tr></thead><tbody>
 ${data.fleets.map(f=>`<tr><td><strong>${f.name}</strong></td><td>${f.slug}</td><td><span class="status live">${f.status}</span></td><td>Managed in MOVA</td></tr>`).join("")}
 </tbody></table></div></section>`}
function kits(){root.innerHTML=header("Kits","QR identity and equipment availability.",`<button class="btn primary" disabled>Create kit</button>`)+
 `<section class="section"><div class="panel table-wrap"><table><thead><tr><th>Kit</th><th>Status</th><th>Bar</th><th>Handle Band</th><th>Mini Band</th></tr></thead><tbody>
 ${data.kits.map(k=>`<tr><td><strong>${k.code}</strong></td><td><span class="status live">${k.status}</span></td><td>${yes(k.equipment.bar)}</td><td>${yes(k.equipment.handle_band)}</td><td>${yes(k.equipment.mini_band)}</td></tr>`).join("")}
 </tbody></table></div></section>`}
function yes(v){return v?"✓":"—"}
function content(){root.innerHTML=header("Content","Session families controlled from the backend.",`<button class="btn primary" disabled>New movement</button>`)+
 `<section class="section"><div class="section-head"><div><h2>3-minute families</h2><p>12 locked equipment × goal families</p></div></div>
 <div class="content-grid">${data.content.map(c=>`<div class="content-card"><div class="code">${c.code}</div><h3>${c.title}</h3><div class="tags">
 <span class="tag">${labelGoal(c.goal)}</span><span class="tag">${labelEquipment(c.equipment)}</span><span class="tag ${c.status==="ready"?"approved":"draft"}">${c.status}</span>
 </div></div>`).join("")}</div></section>`}
function equipment(){root.innerHTML=header("Equipment","Prototype hardware specifications stored in MOVA.")+
 `<section class="section"><div class="equipment-specs">${data.equipment_specs.map(s=>specCard(s)).join("")}</div></section>`}
function specCard(s){const spec=s.spec||{};const entries=Object.entries(spec).slice(0,7);return `<div class="spec"><div class="eyebrow">V${s.version} · ${s.status}</div><h3>${s.display_name}</h3><dl>
 ${entries.map(([k,v])=>`<div><dt>${k.replaceAll("_"," ")}</dt><dd>${typeof v==="object"?JSON.stringify(v):String(v)}</dd></div>`).join("")}</dl></div>`}
function analytics(){root.innerHTML=header("Analytics","Internal product behaviour and pilot performance.")+
 `<section class="section"><div class="grid-2"><div class="panel"><div class="panel-title">Product events</div><div class="panel-sub">Scan, time choice, goal choice, session start, skip, completion and feedback are already captured by the MOVA backend.</div></div>
 <div class="panel"><div class="panel-title">Production view</div><div class="panel-sub">This section will support drop-off analysis, content quality review, kit utilisation, completion rate and pilot reporting without exposing individual health information.</div></div></div></section>`}
boot();