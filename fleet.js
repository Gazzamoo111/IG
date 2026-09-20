const params=new URLSearchParams(location.search);
const source=params.get("source")==="live"?"&source=live":"";
const fleet=params.get("fleet")?("&fleet="+encodeURIComponent(params.get("fleet"))):"";
const API="https://nslfyglqamrhbqfdwftr.supabase.co/functions/v1/mova-console?key=mova_console_demo_v1&mode=fleet"+source+fleet;
const root=document.getElementById("fleet-app");
const pct=v=>Math.max(0,Math.min(100,Number(v)||0));
function metric(label,value,note=""){return \`<div class="metric"><div class="metric-label">\${label}</div><div class="metric-value">\${value}</div><div class="metric-note">\${note}</div></div>\`}
function mix(title,items){return \`<div class="panel"><div class="panel-title">\${title}</div><div class="mix-list">\${items.map(x=>\`<div class="mix-row"><div class="mix-name">\${x.label}</div><div class="mix-track"><div class="mix-fill" style="width:\${pct(x.value)}%"></div></div><div class="mix-value">\${x.value}%</div></div>\`).join("")}</div></div>\`}
async function boot(){try{const r=await fetch(API);const d=await r.json();if(!r.ok)throw new Error(d.error||"Unable to load dashboard");render(d.fleet,d.data_mode)}catch(e){root.innerHTML=\`<div class="notice">\${e.message}</div>\`}}
function render(f,dataMode){
 const m=f.metrics;
 const max=Math.max(1,...f.weekly_sessions.map(x=>x.value));
 const num=(v,fallback="—")=>v===null||v===undefined?fallback:v;
 const pctValue=v=>v===null||v===undefined?"—":v+"%";
 const dataNotice=dataMode==="live"
  ?\`<div class="notice" style="margin-top:18px"><strong>Live pilot view.</strong> These figures are calculated from recorded MOVA sessions.</div>\`
  :\`<div class="notice" style="margin-top:18px"><strong>Prototype view.</strong> These figures are representative demo data used to prove the employer experience.</div>\`;
 root.className="";
 root.innerHTML=\`
 <div class="eyebrow">MOVA Fleet</div><h1>\${f.name}</h1><div class="sub">Participation and engagement · \${f.period}</div>
 \${dataNotice}
 <div class="metrics">
  \${metric("Drivers",num(m.drivers),"Fleet population")}
  \${metric("Activated",num(m.activated,0),"Used MOVA at least once")}
  \${metric("Activation",pctValue(m.activation_rate),"Fleet adoption")}
  \${metric("Sessions",m.sessions_this_week,"This week")}
  \${metric("Repeat users",m.repeat_users_rate+"%","Used MOVA more than once")}
  \${metric("Movement",m.movement_minutes.toLocaleString()+" min","Total this week")}
 </div>
 <section class="section"><div class="section-head"><div><h2>Usage this week</h2><p>Completed sessions by day</p></div><button class="btn" disabled>Export report</button></div>
 <div class="grid-2"><div class="panel"><div class="panel-title">Sessions</div><div class="bars">\${f.weekly_sessions.map(x=>\`<div class="bar-col"><div class="bar-value">\${x.value}</div><div class="bar" style="height:\${Math.round(x.value/max*155)+15}px"></div><div class="bar-label">\${x.day}</div></div>\`).join("")}</div></div>
 \${mix("Session duration",f.duration_mix)}</div></section>
 <section class="section"><div class="grid-3">\${mix("Goals",f.goals)}\${mix("Equipment use",f.equipment)}
 <div class="panel"><div class="panel-title">Privacy by design</div><div class="panel-sub">Employers see aggregate participation, not individual health profiles.</div>
 <div class="notice" style="margin-top:20px">No pain scores, medical information, diagnoses or individual difficulty ratings appear in the fleet dashboard.</div></div></div></section>
 <section class="section"><div class="section-head"><div><h2>Locations</h2><p>Aggregate site-level rollout</p></div></div><div class="panel table-wrap"><table>
 <thead><tr><th>Site</th><th>Activation</th><th>Sessions</th><th>Status</th></tr></thead><tbody>
 \${f.sites.map(s=>\`<tr><td><strong>\${s.name}</strong></td><td>\${s.activation===null||s.activation===undefined?"—":s.activation+"%"}</td><td>\${s.sessions}</td><td><span class="status live">Active</span></td></tr>\`).join("")}
 </tbody></table></div></section>\`;
}
boot();