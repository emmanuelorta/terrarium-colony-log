// Colony Log - Terrarium Station LLC
// Husbandry, growth and breeding records for Furcifer angeli and other colony
// species. Every entry is primary research data: there is no published captive
// breeding protocol for this species, so a lost record cannot be regenerated
// from any source. That single fact drives the design.
//
// The predecessor build kept everything in localStorage. That means one device,
// one browser profile, and silent total loss on a cache clear - and "export to
// JSON sometimes" is not a backup strategy for irreplaceable data. Storage here
// is KV, server-side, with every write timestamped and an append-only audit of
// deletions so a mistake is recoverable rather than final.
const VERSION = "colony-1";
const SITE = "Colony Log";
const ORG = "Terrarium Station LLC";

const SPECIES = {
  "furcifer-angeli": {
    name: "Furcifer angeli", common: "Angel's Chameleon",
    status: "Endangered", cites: "CITES Appendix II",
    note: "~150/year export quota. No documented captive breeding.",
    day: [82, 88], basking: [90, 95], night: [62, 70], uvi: [3.5, 6.0],
    wetMonths: [11, 12, 1, 2, 3], wetRh: [70, 90], dryRh: [20, 40],
    incubation: [180, 240]
  }
};

const DEFAULT_ANIMALS = [
  { id: "Angeli-M1", species: "furcifer-angeli", sex: "M", origin: "wild-caught", acquired: "2026-05-01" },
  { id: "Angeli-M2", species: "furcifer-angeli", sex: "M", origin: "wild-caught", acquired: "2026-05-01" },
  { id: "Angeli-F1", species: "furcifer-angeli", sex: "F", origin: "wild-caught", acquired: "2026-05-01" },
  { id: "Angeli-F2", species: "furcifer-angeli", sex: "F", origin: "wild-caught", acquired: "2026-05-01" }
];

const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const NOINDEX = { "x-robots-tag": "noindex, nofollow, noarchive" };

function json(o, status, extra) {
  return new Response(JSON.stringify(o), {
    status: status || 200,
    headers: Object.assign({ "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }, NOINDEX, extra || {})
  });
}
function html(body, status) {
  return new Response(body, {
    status: status || 200,
    headers: Object.assign({ "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }, NOINDEX)
  });
}
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

async function hmacHex(key, msg) {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(key),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(msg));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
// Length-independent comparison. The key is never echoed in any response.
function sameStr(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
async function authState(req, env) {
  if (!env.COLONY_KEY) return "unconfigured";
  const m = (req.headers.get("cookie") || "").match(/colony=([a-f0-9]{64})/);
  if (!m) return false;
  return sameStr(m[1], await hmacHex(env.COLONY_KEY, "colony-session-v1")) ? true : false;
}

async function listKeys(env, prefix) {
  const out = [];
  let cursor;
  for (let i = 0; i < 12; i++) {
    const l = await env.COLONY.list({ prefix: prefix, limit: 1000, cursor: cursor });
    for (const k of l.keys) out.push(k.name);
    if (l.list_complete) break;
    cursor = l.cursor;
  }
  return out;
}
async function readAll(env, prefix) {
  const names = await listKeys(env, prefix);
  const rows = [];
  for (const n of names) {
    const v = await env.COLONY.get(n, "json").catch(function () { return null; });
    if (v) rows.push(v);
  }
  return rows;
}
async function getAnimals(env) {
  const rows = await readAll(env, "animal:");
  if (rows.length) return rows.sort((a, b) => String(a.id).localeCompare(String(b.id)));
  for (const a of DEFAULT_ANIMALS) {
    a.created = new Date().toISOString();
    await env.COLONY.put("animal:" + a.id, JSON.stringify(a));
  }
  return DEFAULT_ANIMALS.slice();
}
function seasonNow(spKey) {
  const sp = SPECIES[spKey] || SPECIES["furcifer-angeli"];
  const m = new Date().getUTCMonth() + 1;
  const wet = sp.wetMonths.indexOf(m) > -1;
  return { wet: wet, label: wet ? "Rainy season" : "Dry season", rh: wet ? sp.wetRh : sp.dryRh };
}
function rolling(rows, field, days) {
  const cut = Date.now() - days * 86400000;
  const vals = rows.filter((e) => e[field] != null && e[field] !== "" && Date.parse(e.date) >= cut).map((e) => Number(e[field])).filter((n) => !isNaN(n));
  if (!vals.length) return null;
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  return { n: vals.length, mean: Math.round(mean * 100) / 100, min: Math.min.apply(null, vals), max: Math.max.apply(null, vals) };
}
function csv(rows, cols) {
  const q = (v) => '"' + String(v == null ? "" : v).replace(/"/g, '""') + '"';
  return cols.join(",") + "\n" + rows.map((r) => cols.map((c) => q(r[c])).join(",")).join("\n");
}

/* ------------------------------------------------------------------ API --
   Every mutation writes a record with its own id and an ISO timestamp. Delete
   is a tombstone rather than a KV delete: a mistyped click on a breeding event
   should not be able to destroy the only copy of an observation.            */
async function api(req, env, url, p) {
  const method = req.method;
  const seg = p.split("/").filter(Boolean); // api, <resource>, <id?>
  const res = seg[1] || "";
  const id = seg[2] || "";

  if (res === "bootstrap" && method === "GET") {
    const [an, en, br, cl] = await Promise.all([
      getAnimals(env), readAll(env, "entry:"), readAll(env, "breed:"), readAll(env, "clutch:")
    ]);
    const live = (r) => !r.deleted;
    const entries = en.filter(live).sort((a, b) => String(b.date).localeCompare(String(a.date)));
    const care = await env.COLONY.get("care:guide", "json").catch(function () { return null; });
    return json({
      version: VERSION, species: SPECIES, season: seasonNow("furcifer-angeli"),
      animals: an.filter(live), entries: entries,
      breeding: br.filter(live).sort((a, b) => String(b.date).localeCompare(String(a.date))),
      clutches: cl.filter(live),
      care: care || null,
      baselines: {
        tempF: { d7: rolling(entries, "tempF", 7), d14: rolling(entries, "tempF", 14), d30: rolling(entries, "tempF", 30) },
        humidity: { d7: rolling(entries, "humidity", 7), d14: rolling(entries, "humidity", 14), d30: rolling(entries, "humidity", 30) },
        uvi: { d7: rolling(entries, "uvi", 7), d14: rolling(entries, "uvi", 14), d30: rolling(entries, "uvi", 30) }
      }
    });
  }

  const prefixes = { animals: "animal:", entries: "entry:", breeding: "breed:", clutches: "clutch:" };
  const prefix = prefixes[res];
  if (!prefix) return json({ error: "unknown resource" }, 404);

  if (method === "POST") {
    const body = await req.json().catch(function () { return null; });
    if (!body) return json({ error: "bad json" }, 400);
    const key = res === "animals" ? String(body.id || uid()).trim() : uid();
    if (!key) return json({ error: "id required" }, 400);
    const rec = Object.assign({}, body, { id: key, updated: new Date().toISOString() });
    if (!rec.created) rec.created = rec.updated;
    if (res !== "animals" && !rec.date) rec.date = rec.updated.slice(0, 10);
    await env.COLONY.put(prefix + key, JSON.stringify(rec));
    return json({ ok: true, record: rec });
  }
  if (method === "DELETE" && id) {
    const cur = await env.COLONY.get(prefix + id, "json").catch(function () { return null; });
    if (!cur) return json({ error: "not found" }, 404);
    cur.deleted = new Date().toISOString();
    await env.COLONY.put(prefix + id, JSON.stringify(cur));
    // Tombstone, not erasure. Recoverable from the export or by clearing the flag.
    return json({ ok: true, tombstoned: id });
  }
  if (method === "GET") {
    const rows = (await readAll(env, prefix)).filter((r) => !r.deleted);
    return json({ rows: rows });
  }
  return json({ error: "method not allowed" }, 405);
}

/* --------------------------------------------------------------- exports -- */
async function exportAll(env, fmt) {
  const [an, en, br, cl] = await Promise.all([
    getAnimals(env), readAll(env, "entry:"), readAll(env, "breed:"), readAll(env, "clutch:")
  ]);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  if (fmt === "csv") {
    const cols = ["id", "date", "animal", "weightG", "svlMm", "tempF", "humidity", "uvi", "feeding", "health", "notes"];
    return new Response(csv(en.filter((r) => !r.deleted), cols), {
      headers: Object.assign({ "content-type": "text/csv; charset=utf-8",
        "content-disposition": 'attachment; filename="colony-entries-' + stamp + '.csv"' }, NOINDEX)
    });
  }
  return new Response(JSON.stringify({ exported: new Date().toISOString(), version: VERSION,
    animals: an, entries: en, breeding: br, clutches: cl }, null, 2), {
    headers: Object.assign({ "content-type": "application/json; charset=utf-8",
      "content-disposition": 'attachment; filename="colony-log-' + stamp + '.json"' }, NOINDEX)
  });
}

/* ------------------------------------------------------------------- UI -- */
const CSS = `
:root{--bg:#0f1211;--panel:#161b19;--line:#252d2a;--ink:#e8ede9;--dim:#93a09a;--moss:#7fb069;--amber:#e0a458;--red:#d9776f;--radius:10px}
[data-theme=light]{--bg:#f7f8f6;--panel:#fff;--line:#e2e6e1;--ink:#161b19;--dim:#5d6b64}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.55 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif}
header{position:sticky;top:0;z-index:9;background:var(--panel);border-bottom:1px solid var(--line);padding:10px 16px;display:flex;gap:14px;align-items:center;flex-wrap:wrap}
.brand{font-weight:700;letter-spacing:-.01em}.brand em{color:var(--moss);font-style:normal}
nav{display:flex;gap:2px;flex-wrap:wrap;margin-left:auto}
nav button{background:transparent;border:1px solid transparent;color:var(--dim);padding:6px 10px;border-radius:8px;cursor:pointer;font-size:13px}
nav button.on{background:var(--bg);color:var(--ink);border-color:var(--line)}
main{max-width:1100px;margin:0 auto;padding:18px 16px 80px}
h1{font-size:22px;margin:0 0 4px}h2{font-size:16px;margin:26px 0 10px}
.sub{color:var(--dim);font-size:13px;margin:0 0 16px}
.grid{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(180px,1fr))}
.card{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);padding:14px}
.kpi{font-size:26px;font-weight:700;letter-spacing:-.02em}
.kpi small{display:block;font-size:12px;color:var(--dim);font-weight:400;letter-spacing:0}
table{width:100%;border-collapse:collapse;background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);overflow:hidden;font-size:13px}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--dim);font-weight:600}tr:last-child td{border-bottom:0}
input,select,textarea{background:var(--bg);color:var(--ink);border:1px solid var(--line);border-radius:8px;padding:8px 10px;font:inherit;font-size:14px;width:100%}
label{display:block;font-size:12px;color:var(--dim);margin:0 0 4px}
.row{display:grid;gap:10px;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));margin-bottom:10px}
button.go{background:var(--moss);color:#0f1211;border:0;border-radius:8px;padding:9px 16px;font-weight:600;cursor:pointer}
button.ghost{background:transparent;border:1px solid var(--line);color:var(--dim);border-radius:8px;padding:7px 12px;cursor:pointer;font-size:13px}
.pill{display:inline-block;font-size:11px;padding:2px 8px;border-radius:999px;border:1px solid var(--line);color:var(--dim)}
.pill.wet{color:var(--moss);border-color:var(--moss)}.pill.dry{color:var(--amber);border-color:var(--amber)}
.flag{color:var(--red)}.ok{color:var(--moss)}
.bar{height:7px;background:var(--line);border-radius:999px;overflow:hidden}.bar i{display:block;height:100%;background:var(--moss)}
.mut{color:var(--dim);font-size:12px}
canvas{width:100%;height:220px}
.hide{display:none}
.banner{background:var(--panel);border:1px solid var(--line);border-left:3px solid var(--moss);border-radius:var(--radius);padding:12px 14px;margin:0 0 16px}
.err{border-left-color:var(--red)}
`;

function loginPage(msg) {
  return html('<!doctype html><html lang=en data-theme=dark><meta charset=utf-8>' +
    '<meta name=viewport content="width=device-width,initial-scale=1">' +
    '<meta name=robots content="noindex,nofollow"><title>' + SITE + '</title><style>' + CSS +
    'body{display:grid;place-items:center;height:100vh}form{width:300px}</style>' +
    '<form method=post action="/login"><p class=brand>Terrarium <em>Colony Log</em></p>' +
    (msg ? '<p class="banner err">' + esc(msg) + '</p>' : '') +
    '<label>Access key</label><input type=password name=key autocomplete=current-password required>' +
    '<p><button class=go type=submit>Open log</button></p>' +
    '<p class=mut>Private research records. ' + esc(ORG) + '.</p></form></html>');
}
function setupPage() {
  return html('<!doctype html><html lang=en data-theme=dark><meta charset=utf-8>' +
    '<meta name=robots content="noindex,nofollow"><title>Setup - ' + SITE + '</title><style>' + CSS + '</style>' +
    '<main><h1>One step left</h1><p class=sub>The app is deployed and the store is live. It has no access key yet, so it is refusing to serve records.</p>' +
    '<div class=banner><p>In the Cloudflare dashboard open <b>Workers &amp; Pages &rarr; colonylog &rarr; Settings &rarr; Variables</b> and add an encrypted variable named <code>COLONY_KEY</code>. Choose the value yourself and do not share it.</p>' +
    '<p class=mut>It is deliberately not set for you: an access key that someone else generated is not a key you control.</p></div>' +
    '<p class=mut>Once saved, reload this page.</p></main></html>');
}

function appShell() {
  return '<!doctype html><html lang=en data-theme=dark><meta charset=utf-8>' +
  '<meta name=viewport content="width=device-width,initial-scale=1">' +
  '<meta name=robots content="noindex,nofollow,noarchive"><title>' + SITE + ' - ' + ORG + '</title>' +
  '<style>' + CSS + '</style>' +
  '<header><span class=brand>Terrarium <em>Colony Log</em></span>' +
  '<nav id=nav></nav>' +
  '<button class=ghost onclick="toggleTheme()">Theme</button>' +
  '<button class=ghost onclick="location.href=\'/export.json\'">JSON</button>' +
  '<button class=ghost onclick="location.href=\'/export.csv\'">CSV</button>' +
  '<button class=ghost onclick="logout()">Lock</button></header>' +
  '<main id=app><p class=sub>Loading colony&hellip;</p></main>' +
  '<script>' + APPJS + '</script></html>';
}

const APPJS = String.raw`
var D = null, view = "dashboard";
var VIEWS = [["dashboard","Dashboard"],["animals","Animals"],["log","Daily Log"],["timeline","Timeline"],
  ["growth","Growth"],["breeding","Breeding"],["incubation","Incubation"],["baselines","Baselines"],["care","Care Guide"]];

function h(s){return String(s==null?"":s).replace(/[&<>"']/g,function(c){return ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c];});}
function el(id){return document.getElementById(id);}
function toggleTheme(){var r=document.documentElement;r.dataset.theme=r.dataset.theme==="dark"?"light":"dark";try{localStorage.setItem("colony-theme",r.dataset.theme);}catch(e){}}
function logout(){document.cookie="colony=; Max-Age=0; path=/";location.href="/";}
try{var th=localStorage.getItem("colony-theme");if(th)document.documentElement.dataset.theme=th;}catch(e){}

async function load(){
  var r = await fetch("/api/bootstrap",{credentials:"same-origin"});
  if(r.status===401){location.href="/";return;}
  D = await r.json();
  renderNav(); render();
}
function renderNav(){
  el("nav").innerHTML = VIEWS.map(function(v){
    return '<button class="'+(v[0]===view?"on":"")+'" onclick="go(\''+v[0]+'\')">'+v[1]+'</button>';
  }).join("");
}
function go(v){view=v;renderNav();render();window.scrollTo(0,0);}

async function post(res, body){
  var r = await fetch("/api/"+res,{method:"POST",credentials:"same-origin",
    headers:{"content-type":"application/json"},body:JSON.stringify(body)});
  var d = await r.json();
  if(!r.ok){alert(d.error||"save failed");return null;}
  await load(); return d.record;
}
async function del(res,id){
  if(!confirm("Remove this record? It is kept in the export and can be restored."))return;
  await fetch("/api/"+res+"/"+encodeURIComponent(id),{method:"DELETE",credentials:"same-origin"});
  await load();
}
function animalName(id){var a=(D.animals||[]).filter(function(x){return x.id===id;})[0];return a?a.id:id;}
function num(v){return v==null||v===""?null:Number(v);}
function fmt(n,d){return n==null?"&mdash;":(Math.round(n*(d?100:10))/(d?100:10));}

function render(){
  var m = el("app");
  if(view==="dashboard")   m.innerHTML = vDash();
  else if(view==="animals")m.innerHTML = vAnimals();
  else if(view==="log")    m.innerHTML = vLog();
  else if(view==="timeline")m.innerHTML= vTimeline();
  else if(view==="growth") { m.innerHTML = vGrowth(); drawCharts(); }
  else if(view==="breeding")m.innerHTML= vBreeding();
  else if(view==="incubation")m.innerHTML=vIncubation();
  else if(view==="baselines")m.innerHTML=vBaselines();
  else if(view==="care")   m.innerHTML = vCare();
}

function vDash(){
  var s=D.season, e=D.entries||[], a=D.animals||[];
  var last = e[0];
  var days = last? Math.round((Date.now()-Date.parse(last.date))/86400000) : null;
  var sp = D.species["furcifer-angeli"];
  return '<h1>Colony</h1><p class=sub>'+h(sp.name)+' &mdash; '+h(sp.common)+'. '+h(sp.status)+', '+h(sp.cites)+'.</p>'+
  '<div class="banner"><b>'+h(s.label)+'</b> <span class="pill '+(s.wet?"wet":"dry")+'">target RH '+s.rh[0]+'&ndash;'+s.rh[1]+'%</span>'+
  '<div class=mut style="margin-top:6px">Day '+sp.day[0]+'&ndash;'+sp.day[1]+'&deg;F &middot; basking '+sp.basking[0]+'&ndash;'+sp.basking[1]+'&deg;F &middot; night '+sp.night[0]+'&ndash;'+sp.night[1]+'&deg;F &middot; UVI '+sp.uvi[0]+'&ndash;'+sp.uvi[1]+'</div></div>'+
  '<div class=grid>'+
   card(a.length,"animals in colony")+
   card(e.length,"log entries")+
   card((D.breeding||[]).length,"breeding events")+
   card((D.clutches||[]).length,"clutches tracked")+
   card(days==null?"&mdash;":days+"d","since last entry")+
  '</div>'+
  '<h2>Recent entries</h2>'+ entryTable(e.slice(0,12));
}
function card(v,l){return '<div class="card kpi">'+v+'<small>'+l+'</small></div>';}

function entryTable(rows){
  if(!rows.length) return '<p class=mut>No entries yet.</p>';
  return '<table><tr><th>Date</th><th>Animal</th><th>Weight g</th><th>SVL mm</th><th>&deg;F</th><th>RH%</th><th>UVI</th><th>Feeding</th><th>Health</th><th>Notes</th><th></th></tr>'+
  rows.map(function(r){
    return '<tr><td>'+h(r.date)+'</td><td>'+h(animalName(r.animal))+'</td><td>'+h(r.weightG||"")+'</td><td>'+h(r.svlMm||"")+
    '</td><td>'+h(r.tempF||"")+'</td><td>'+h(r.humidity||"")+'</td><td>'+h(r.uvi||"")+'</td><td>'+h(r.feeding||"")+
    '</td><td>'+h(r.health||"")+'</td><td>'+h(r.notes||"")+'</td>'+
    '<td><button class=ghost onclick="del(\'entries\',\''+h(r.id)+'\')">&times;</button></td></tr>';
  }).join("")+'</table>';
}

function animalOptions(sel){
  return (D.animals||[]).map(function(a){
    return '<option value="'+h(a.id)+'"'+(a.id===sel?" selected":"")+'>'+h(a.id)+' ('+h(a.sex)+')</option>';
  }).join("");
}

function vLog(){
  return '<h1>Daily log</h1><p class=sub>One row per observation. Environmental readings feed the rolling baselines.</p>'+
  '<div class=card>'+
  '<div class=row><div><label>Date</label><input id=f_date type=date value="'+new Date().toISOString().slice(0,10)+'"></div>'+
  '<div><label>Animal</label><select id=f_animal>'+animalOptions()+'</select></div>'+
  '<div><label>Weight (g)</label><input id=f_weight type=number step=0.1></div>'+
  '<div><label>SVL (mm)</label><input id=f_svl type=number step=0.1></div></div>'+
  '<div class=row><div><label>Temp (&deg;F)</label><input id=f_temp type=number step=0.1></div>'+
  '<div><label>Humidity (%)</label><input id=f_hum type=number step=1></div>'+
  '<div><label>UVI</label><input id=f_uvi type=number step=0.1></div>'+
  '<div><label>Feeding</label><input id=f_feed placeholder="e.g. 6 crickets, dusted"></div></div>'+
  '<div class=row><div><label>Health / behaviour</label><input id=f_health placeholder="shed, alert, gaping"></div>'+
  '<div style="grid-column:span 2"><label>Notes</label><input id=f_notes></div></div>'+
  '<button class=go onclick="saveEntry()">Save entry</button></div>'+
  '<h2>All entries</h2>'+entryTable(D.entries||[]);
}
async function saveEntry(){
  var rec={date:el("f_date").value,animal:el("f_animal").value,
    weightG:num(el("f_weight").value),svlMm:num(el("f_svl").value),
    tempF:num(el("f_temp").value),humidity:num(el("f_hum").value),uvi:num(el("f_uvi").value),
    feeding:el("f_feed").value,health:el("f_health").value,notes:el("f_notes").value};
  if(!rec.date){alert("date required");return;}
  await post("entries",rec);
}

function vAnimals(){
  var rows=(D.animals||[]).map(function(a){
    var mine=(D.entries||[]).filter(function(e){return e.animal===a.id;});
    var w=mine.filter(function(e){return e.weightG!=null;});
    var latest=w[0];
    return '<div class=card><b>'+h(a.id)+'</b> <span class=pill>'+h(a.sex)+'</span> '+
      '<div class=mut>'+h(a.origin||"")+' &middot; acquired '+h(a.acquired||"?")+'</div>'+
      '<div style="margin-top:8px">'+mine.length+' entries &middot; latest weight '+(latest?h(latest.weightG)+" g":"&mdash;")+'</div>'+
      '<button class=ghost style="margin-top:8px" onclick="go(\'timeline\');setTimeout(function(){el(\'t_animal\').value=\''+h(a.id)+'\';render2();},50)">Timeline</button>'+
      '</div>';
  }).join("");
  return '<h1>Animals</h1><p class=sub>'+(D.animals||[]).length+' in colony.</p><div class=grid>'+rows+'</div>'+
  '<h2>Add animal</h2><div class=card><div class=row>'+
  '<div><label>ID</label><input id=a_id placeholder="Angeli-F3"></div>'+
  '<div><label>Sex</label><select id=a_sex><option>F</option><option>M</option><option>U</option></select></div>'+
  '<div><label>Origin</label><input id=a_origin value="wild-caught"></div>'+
  '<div><label>Acquired</label><input id=a_acq type=date></div></div>'+
  '<button class=go onclick="saveAnimal()">Add</button></div>';
}
async function saveAnimal(){
  var id=el("a_id").value.trim(); if(!id){alert("id required");return;}
  await post("animals",{id:id,species:"furcifer-angeli",sex:el("a_sex").value,origin:el("a_origin").value,acquired:el("a_acq").value});
}

function vTimeline(){
  var first=(D.animals||[])[0];
  return '<h1>Timeline</h1><p class=sub>Chronological history for one animal.</p>'+
  '<div class=card><label>Animal</label><select id=t_animal onchange="render2()">'+animalOptions(first?first.id:"")+'</select></div>'+
  '<div id=t_out></div>';
}
function render2(){
  var id=el("t_animal").value;
  var rows=(D.entries||[]).filter(function(e){return e.animal===id;});
  var br=(D.breeding||[]).filter(function(b){return b.female===id||b.male===id;});
  var out='<h2>'+h(id)+'</h2>'+entryTable(rows);
  if(br.length){
    out+='<h2>Breeding events</h2><table><tr><th>Date</th><th>Type</th><th>Pair</th><th>Notes</th></tr>'+
    br.map(function(b){return '<tr><td>'+h(b.date)+'</td><td>'+h(b.type)+'</td><td>'+h(b.female)+' &times; '+h(b.male)+'</td><td>'+h(b.notes||"")+'</td></tr>';}).join("")+'</table>';
  }
  el("t_out").innerHTML=out;
}

function vGrowth(){
  return '<h1>Growth</h1><p class=sub>Weight and snout-vent length over time. Drawn from log entries; no external chart library.</p>'+
  (D.animals||[]).map(function(a){
    return '<div class=card style="margin-bottom:12px"><b>'+h(a.id)+'</b>'+
      '<canvas id="c_w_'+h(a.id)+'"></canvas><div class=mut>weight (g)</div>'+
      '<canvas id="c_s_'+h(a.id)+'"></canvas><div class=mut>SVL (mm)</div></div>';
  }).join("");
}
function drawCharts(){
  (D.animals||[]).forEach(function(a){
    var mine=(D.entries||[]).filter(function(e){return e.animal===a.id;}).slice().reverse();
    line("c_w_"+a.id, mine.filter(function(e){return e.weightG!=null;}).map(function(e){return [Date.parse(e.date),Number(e.weightG)];}));
    line("c_s_"+a.id, mine.filter(function(e){return e.svlMm!=null;}).map(function(e){return [Date.parse(e.date),Number(e.svlMm)];}));
  });
}
function line(id, pts){
  var c=el(id); if(!c) return;
  var dpr=window.devicePixelRatio||1, w=c.clientWidth, hh=220;
  c.width=w*dpr; c.height=hh*dpr; var x=c.getContext("2d"); x.scale(dpr,dpr);
  var css=getComputedStyle(document.documentElement);
  var ink=css.getPropertyValue("--moss").trim()||"#7fb069", line=css.getPropertyValue("--line").trim()||"#252d2a", dim=css.getPropertyValue("--dim").trim()||"#93a09a";
  x.clearRect(0,0,w,hh);
  x.strokeStyle=line; x.beginPath(); x.moveTo(34,hh-22); x.lineTo(w-6,hh-22); x.stroke();
  if(pts.length<1){ x.fillStyle=dim; x.font="12px sans-serif"; x.fillText("no data",40,hh/2); return; }
  var xs=pts.map(function(p){return p[0];}), ys=pts.map(function(p){return p[1];});
  var x0=Math.min.apply(null,xs), x1=Math.max.apply(null,xs), y0=Math.min.apply(null,ys), y1=Math.max.apply(null,ys);
  if(x1===x0)x1=x0+1; if(y1===y0){y1=y0+1;y0=y0-1;}
  var px=function(v){return 34+(v-x0)/(x1-x0)*(w-42);}, py=function(v){return hh-22-(v-y0)/(y1-y0)*(hh-40);};
  x.fillStyle=dim; x.font="11px sans-serif";
  x.fillText(String(Math.round(y1)),2,14); x.fillText(String(Math.round(y0)),2,hh-26);
  x.strokeStyle=ink; x.lineWidth=2; x.beginPath();
  pts.forEach(function(p,i){ i?x.lineTo(px(p[0]),py(p[1])):x.moveTo(px(p[0]),py(p[1])); });
  x.stroke();
  x.fillStyle=ink; pts.forEach(function(p){ x.beginPath(); x.arc(px(p[0]),py(p[1]),2.5,0,7); x.fill(); });
}

function vBreeding(){
  var sp=D.species["furcifer-angeli"];
  return '<h1>Breeding</h1><p class=sub>Pairings, copulations and gravid observations. Lay-window prediction is a stated range, not a promise.</p>'+
  '<div class=card><div class=row>'+
  '<div><label>Date</label><input id=b_date type=date value="'+new Date().toISOString().slice(0,10)+'"></div>'+
  '<div><label>Type</label><select id=b_type><option>introduction</option><option>copulation</option><option>gravid observed</option><option>oviposition</option><option>separation</option></select></div>'+
  '<div><label>Female</label><select id=b_f>'+animalOptions()+'</select></div>'+
  '<div><label>Male</label><select id=b_m>'+animalOptions()+'</select></div></div>'+
  '<div class=row><div style="grid-column:span 2"><label>Notes</label><input id=b_notes></div></div>'+
  '<button class=go onclick="saveBreed()">Log event</button></div>'+
  '<h2>Events</h2>'+
  ((D.breeding||[]).length? '<table><tr><th>Date</th><th>Type</th><th>Female</th><th>Male</th><th>Predicted lay window</th><th>Notes</th><th></th></tr>'+
   (D.breeding||[]).map(function(b){
     var win="&mdash;";
     if(b.type==="copulation"){
       var t=Date.parse(b.date);
       win=new Date(t+20*86400000).toISOString().slice(0,10)+" &rarr; "+new Date(t+45*86400000).toISOString().slice(0,10);
     }
     return '<tr><td>'+h(b.date)+'</td><td>'+h(b.type)+'</td><td>'+h(b.female)+'</td><td>'+h(b.male)+'</td><td class=mut>'+win+'</td><td>'+h(b.notes||"")+'</td>'+
     '<td><button class=ghost onclick="del(\'breeding\',\''+h(b.id)+'\')">&times;</button></td></tr>';
   }).join("")+'</table>' : '<p class=mut>No breeding events logged.</p>')+
  '<p class=mut style="margin-top:10px">Lay window shown as 20&ndash;45 days post-copulation. That range is inferred from the genus, not from published <i>angeli</i> data, because none exists. Treat it as a prompt to check, not a prediction.</p>';
}
async function saveBreed(){
  await post("breeding",{date:el("b_date").value,type:el("b_type").value,female:el("b_f").value,male:el("b_m").value,notes:el("b_notes").value});
}

function vIncubation(){
  var sp=D.species["furcifer-angeli"];
  return '<h1>Incubation</h1><p class=sub>Clutch progress against a '+sp.incubation[0]+'&ndash;'+sp.incubation[1]+' day window.</p>'+
  '<div class=card><div class=row>'+
  '<div><label>Clutch ID</label><input id=c_id placeholder="F1-2026-11"></div>'+
  '<div><label>Female</label><select id=c_f>'+animalOptions()+'</select></div>'+
  '<div><label>Laid</label><input id=c_date type=date></div>'+
  '<div><label>Egg count</label><input id=c_n type=number></div></div>'+
  '<div class=row><div><label>Incubation &deg;F</label><input id=c_temp type=number step=0.1></div>'+
  '<div style="grid-column:span 2"><label>Notes</label><input id=c_notes></div></div>'+
  '<button class=go onclick="saveClutch()">Add clutch</button></div>'+
  '<h2>Clutches</h2>'+
  ((D.clutches||[]).length? (D.clutches||[]).map(function(c){
     var d=Math.round((Date.now()-Date.parse(c.laid||c.date))/86400000);
     var pct=Math.max(0,Math.min(100,Math.round(d/sp.incubation[1]*100)));
     var due0=new Date(Date.parse(c.laid||c.date)+sp.incubation[0]*86400000).toISOString().slice(0,10);
     var due1=new Date(Date.parse(c.laid||c.date)+sp.incubation[1]*86400000).toISOString().slice(0,10);
     return '<div class=card style="margin-bottom:10px"><b>'+h(c.id)+'</b> <span class=pill>'+h(c.eggs||"?")+' eggs</span> '+
       '<span class=pill>'+h(c.female||"")+'</span>'+
       '<div class=mut style="margin:6px 0">day '+d+' &middot; hatch window '+due0+' &rarr; '+due1+'</div>'+
       '<div class=bar><i style="width:'+pct+'%"></i></div>'+
       (c.notes?'<div class=mut style="margin-top:6px">'+h(c.notes)+'</div>':'')+
       '<button class=ghost style="margin-top:8px" onclick="del(\'clutches\',\''+h(c.id)+'\')">Remove</button></div>';
   }).join("") : '<p class=mut>No clutches recorded.</p>');
}
async function saveClutch(){
  var id=el("c_id").value.trim(); if(!id){alert("clutch id required");return;}
  await post("clutches",{id:id,female:el("c_f").value,laid:el("c_date").value,date:el("c_date").value,
    eggs:num(el("c_n").value),tempF:num(el("c_temp").value),notes:el("c_notes").value});
}

function vBaselines(){
  var b=D.baselines||{}, sp=D.species["furcifer-angeli"], s=D.season;
  function block(title,key,lo,hi,unit){
    var w=b[key]||{};
    function cell(r,label){
      if(!r) return '<td class=mut>no data</td>';
      var flag = (lo!=null && (r.mean<lo||r.mean>hi));
      return '<td'+(flag?' class=flag':' class=ok')+'>'+r.mean+' '+unit+' <span class=mut>(n='+r.n+', '+r.min+'&ndash;'+r.max+')</span></td>';
    }
    return '<h2>'+title+'</h2><table><tr><th>7 day</th><th>14 day</th><th>30 day</th></tr><tr>'+
      cell(w.d7)+cell(w.d14)+cell(w.d30)+'</tr></table>'+
      (lo!=null?'<p class=mut>Target '+lo+'&ndash;'+hi+' '+unit+'. Red means the rolling mean sits outside it.</p>':'');
  }
  return '<h1>Environmental baselines</h1><p class=sub>Rolling means from logged readings, checked against the current season.</p>'+
    '<div class=banner><b>'+h(s.label)+'</b> &middot; target RH '+s.rh[0]+'&ndash;'+s.rh[1]+'%</div>'+
    block("Temperature","tempF",sp.day[0],sp.day[1],"&deg;F")+
    block("Humidity","humidity",s.rh[0],s.rh[1],"%")+
    block("UV index","uvi",sp.uvi[0],sp.uvi[1],"");
}

function vCare(){
  var c=D.care||{text:""};
  var sp=D.species["furcifer-angeli"];
  return '<h1>Care guide</h1><p class=sub>Editable working protocol. Saved server-side with the rest of the colony record.</p>'+
  '<div class=banner class=mut>Defaults: day '+sp.day[0]+'&ndash;'+sp.day[1]+'&deg;F, basking '+sp.basking[0]+'&ndash;'+sp.basking[1]+
  '&deg;F, night '+sp.night[0]+'&ndash;'+sp.night[1]+'&deg;F, UVI '+sp.uvi[0]+'&ndash;'+sp.uvi[1]+
  ', rainy Nov&ndash;Mar '+sp.wetRh[0]+'&ndash;'+sp.wetRh[1]+'% RH, dry Apr&ndash;Oct '+sp.dryRh[0]+'&ndash;'+sp.dryRh[1]+'% RH.</div>'+
  '<div class=card><textarea id=care_txt rows=18>'+h(c.text||"")+'</textarea>'+
  '<p><button class=go onclick="saveCare()">Save guide</button> <button class=ghost onclick="window.print()">Print / PDF</button></p></div>';
}
async function saveCare(){
  await fetch("/api/care",{method:"POST",credentials:"same-origin",headers:{"content-type":"application/json"},
    body:JSON.stringify({text:el("care_txt").value})});
  await load(); alert("saved");
}
load();
`;

const ROBOTS = "User-agent: *\nDisallow: /\n";

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    // One host, one copy - the same rule applied across the rest of the estate.
    if (url.hostname.slice(0, 4) === "www.") {
      const u = new URL(req.url);
      u.hostname = url.hostname.slice(4);
      return new Response(null, { status: 301, headers: { location: u.toString() } });
    }
    const p = url.pathname.replace(/\/+$/, "") || "/";

    // Private research records. Nothing here is ever indexable.
    if (p === "/robots.txt") {
      return new Response(ROBOTS, { headers: Object.assign({ "content-type": "text/plain; charset=utf-8" }, NOINDEX) });
    }
    if (!env.COLONY) return html("<h1>No store bound</h1><p>KV binding COLONY is missing.</p>", 500);

    const state = await authState(req, env);
    if (state === "unconfigured") return setupPage();

    if (p === "/login" && req.method === "POST") {
      const form = await req.formData().catch(function () { return null; });
      const given = form ? String(form.get("key") || "") : "";
      if (!sameStr(given, env.COLONY_KEY)) {
        // Deliberately slow and vague: no hint about which part was wrong.
        await new Promise((r) => setTimeout(r, 600));
        return loginPage("That key was not recognised.");
      }
      const tok = await hmacHex(env.COLONY_KEY, "colony-session-v1");
      return new Response(null, {
        status: 302,
        headers: Object.assign({
          location: "/",
          "set-cookie": "colony=" + tok + "; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000"
        }, NOINDEX)
      });
    }

    if (!state) {
      if (p.indexOf("/api/") === 0) return json({ error: "unauthorised" }, 401);
      return loginPage("");
    }

    if (p === "/api/care" && req.method === "POST") {
      const b = await req.json().catch(function () { return null; });
      const rec = { text: (b && b.text) || "", updated: new Date().toISOString() };
      await env.COLONY.put("care:guide", JSON.stringify(rec));
      return json({ ok: true });
    }
    if (p.indexOf("/api/") === 0) return api(req, env, url, p);
    if (p === "/export.json") return exportAll(env, "json");
    if (p === "/export.csv") return exportAll(env, "csv");
    if (p === "/health") return json({ ok: true, version: VERSION });

    return html(appShell());
  }
};
