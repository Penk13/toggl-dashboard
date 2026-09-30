// Toggl Track dashboard as a Cloudflare Worker (port of toggl_dashboard.py).
//
// GET /            last 14 days (cached ~10 min)
// GET /?days=30    1..90 days (days=1 = today's day view)
// GET /?day=2026-09-28  day view for one date within the last 90 days
// GET /?tag=Name   filter every view to entries with that tag ("(no tag)" = untagged)
// GET /?refresh=1  bypass cache
// GET /?sample=1   fake data, no API call
//
// Read-only: only GET requests to Toggl. Token = Worker secret TOGGL_API_TOKEN.
// Protected by Cloudflare Access; the Worker also verifies the Access JWT
// (defense in depth) unless ALLOW_NO_ACCESS="1" (local dev only).

const API = "https://api.track.toggl.com/api/v9";
const DEFAULT_COLOR = "#8a8f98";
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
const CACHE_TTL = 600; // seconds, time entries
const PROJECTS_TTL = 86400; // seconds, project names/colors
const MAX_DAYS = 90;
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAY_MS = 86400e3;
const NO_TAG = "(no tag)";

class HttpError extends Error {
  constructor(status, msg) { super(msg); this.status = status; }
}

export default {
  async fetch(req, env, ctx) {
    if (req.method !== "GET") return new Response("Method not allowed", { status: 405 });
    const url = new URL(req.url);
    if (url.pathname === "/favicon.ico") return new Response(null, { status: 404 });
    if (url.pathname !== "/") return new Response("Not found", { status: 404 });

    if (env.ALLOW_NO_ACCESS !== "1") {
      const why = await verifyAccess(req, env);
      if (why) {
        console.log("access denied:", why); // visible in `npx wrangler tail`
        return new Response("Forbidden", { status: 403 });
      }
    }

    const days = clampDays(url.searchParams.get("days"));
    const off = Number(env.TOGGL_UTC_OFFSET ?? "7") * 3600e3;
    // "Local" time = UTC ms shifted by offset; read with getUTC*().
    const todayLocal = Math.floor((Date.now() + off) / DAY_MS) * DAY_MS;
    const startLocal = todayLocal - (days - 1) * DAY_MS;
    const endLocal = todayLocal + DAY_MS;

    let data;
    try {
      if (url.searchParams.get("sample") === "1") {
        data = { ...sampleData(todayLocal - (MAX_DAYS - 1) * DAY_MS - off, endLocal - off), fetchedAt: Date.now(), cached: false };
      } else {
        if (!env.TOGGL_API_TOKEN) throw new HttpError(500, "TOGGL_API_TOKEN secret not set.");
        // Always MAX_DAYS; every range is sliced from the same cached fetch.
        data = await getData(env, ctx, todayLocal - (MAX_DAYS - 1) * DAY_MS - off, endLocal - off,
          url.searchParams.get("refresh") === "1");
      }
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 502;
      return page(errorHtml(e.message || "Unexpected error", quotaHtml(lastQuota, off)), status >= 500 ? status : 502);
    }

    const all = normalize(data.entries, data.projects, off);
    const quota = quotaHtml(lastQuota, off);
    // Tag filter: applies to the whole page. f.tags = tags offered as filter links (from unfiltered view).
    const tag = (url.searchParams.get("tag") || "").slice(0, 200) || null;
    const allF = tag ? all.filter((r) => (tag === NO_TAG ? !r.tags.length : r.tags.includes(tag))) : all;
    const f = { tag, tags: [] };
    const day = url.searchParams.has("day") ? parseDay(url.searchParams.get("day"), todayLocal) : days === 1 ? todayLocal : null;
    const inView = day !== null ? (r) => r.start >= day && r.start < day + DAY_MS : (r) => r.start >= startLocal;
    f.tags = groupTags(all.filter(inView)).map((t) => t.label);
    const rows = allF.filter(inView);
    return page(day !== null ? renderDay(rows, allF, day, todayLocal, off, data, quota, f)
      : render(rows, startLocal, days, off, data, quota, f));
  },
};

// ---------- data ----------

function clampDays(v) {
  const n = parseInt(v ?? "14", 10);
  return Number.isFinite(n) ? Math.min(Math.max(n, 1), MAX_DAYS) : 14;
}

// "2026-09-28" -> local day start ms, clamped to the cached window (last MAX_DAYS days).
// Invalid -> today.
function parseDay(v, todayLocal) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v || "");
  const d = m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : NaN;
  if (!Number.isFinite(d)) return todayLocal;
  return Math.min(Math.max(d, todayLocal - (MAX_DAYS - 1) * DAY_MS), todayLocal);
}

// Storage: per-isolate memory, then KV if bound as CACHE_KV (survives across isolates),
// else Cache API (no-op on workers.dev). Values kept STALE_TTL so old data can be shown
// when Toggl refuses (quota used up); freshness is checked via fetchedAt, not storage expiry.
const STALE_TTL = 7 * 86400;
const memCache = new Map();

async function loadStored(env, key, ttl) {
  const m = memCache.get(key);
  if (m && Date.now() - m.fetchedAt < ttl * 1000) return m;
  let d = null;
  if (env.CACHE_KV) d = await env.CACHE_KV.get(key, "json");
  else { const res = await caches.default.match(key); if (res) d = await res.json(); }
  const best = d && (!m || d.fetchedAt > m.fetchedAt) ? d : m;
  if (best) memCache.set(key, best);
  return best || null;
}

function saveStored(env, ctx, key, d) {
  memCache.set(key, d);
  const body = JSON.stringify(d);
  ctx.waitUntil((env.CACHE_KV
    ? env.CACHE_KV.put(key, body, { expirationTtl: STALE_TTL })
    : caches.default.put(key, new Response(body, {
      headers: { "Content-Type": "application/json", "Cache-Control": `max-age=${STALE_TTL}` },
    }))).catch((e) => console.log("cache save failed:", e.message)));
}

// Fresh hit -> cached. Else call Toggl, unless quota is known used up. On failure,
// fall back to old stored data (flagged stale) instead of an error page.
async function cached(env, ctx, key, ttl, refresh, load) {
  const old = await loadStored(env, key, ttl);
  if (old && !refresh && Date.now() - old.fetchedAt < ttl * 1000) return { ...old, cached: true };
  const out = quotaWait();
  if (out) {
    if (old) return { ...old, cached: true, stale: `Toggl API quota used up, resets in ${out}` };
    throw new HttpError(502, `Toggl API quota used up, resets in ${out}. No cached data yet.`);
  }
  try {
    const d = { value: await load(), fetchedAt: Date.now() };
    saveStored(env, ctx, key, d);
    return { ...d, cached: false };
  } catch (e) {
    if (old) return { ...old, cached: true, stale: e.message };
    throw e;
  } finally {
    if (lastQuota?.dirty) { lastQuota.dirty = false; saveStored(env, ctx, QUOTA_KEY, lastQuota); }
  }
}

// Entries: 1 Toggl call per CACHE_TTL for all ranges. Projects: cached PROJECTS_TTL,
// refetched early only when an entry references an unknown project id.
async function getData(env, ctx, startUtc, endUtc, refresh) {
  const token = env.TOGGL_API_TOKEN;
  if (!lastQuota) lastQuota = await loadStored(env, QUOTA_KEY, 0);
  const e = await cached(env, ctx, "https://toggl-cache.internal/v3/entries", CACHE_TTL, refresh,
    () => apiGet("/me/time_entries", token, {
      start_date: new Date(startUtc).toISOString(),
      end_date: new Date(endUtc).toISOString(),
    }).then((x) => x || []));
  const pKey = "https://toggl-cache.internal/v3/projects";
  const loadP = () => apiGet("/me/projects", token).then(projectMap);
  // Projects are cosmetic (names/colors): never fail the page over them.
  let p = await cached(env, ctx, pKey, PROJECTS_TTL, false, loadP).catch(() => ({ value: {} }));
  if (!e.stale && e.value.some((x) => x.project_id && !p.value[x.project_id])) {
    p = await cached(env, ctx, pKey, PROJECTS_TTL, true, loadP).catch(() => p);
  }
  return { entries: e.value, projects: p.value, fetchedAt: e.fetchedAt, cached: e.cached, stale: e.stale };
}

// Toggl API quota, from response headers of the last real Toggl call
// (X-Toggl-Quota-Remaining / -Resets-In, seconds). Other quota/rate-limit headers kept raw.
const QUOTA_KEY = "https://toggl-cache.internal/v3/quota";
let lastQuota = null; // { fetchedAt, remaining, resetsIn, raw, dirty? }

function readQuota(res) {
  const raw = {};
  for (const [k, v] of res.headers) if (/quota|ratelimit|rate-limit|retry-after/i.test(k)) raw[k] = v;
  const num = (k) => { const v = res.headers.get(k); return v !== null && Number.isFinite(Number(v)) ? Number(v) : null; };
  lastQuota = { fetchedAt: Date.now(), remaining: num("x-toggl-quota-remaining"),
    resetsIn: num("x-toggl-quota-resets-in") ?? num("retry-after"), raw, dirty: true };
}

// "16m" if quota is known used up and not yet reset, else null.
function quotaWait() {
  const q = lastQuota;
  if (!q || q.remaining !== 0 || q.resetsIn === null) return null;
  const left = q.fetchedAt + q.resetsIn * 1000 - Date.now();
  return left > 0 ? `${Math.ceil(left / 60e3)}m` : null;
}

async function apiGet(path, token, params) {
  const qs = params ? "?" + new URLSearchParams(params) : "";
  console.log("toggl GET", path); // each line = 1 Toggl API quota unit
  const res = await fetch(API + path + qs, {
    headers: { Authorization: "Basic " + btoa(`${token}:api_token`), Accept: "application/json" },
  });
  readQuota(res);
  if (!res.ok) {
    const msg = {
      401: "401: token rejected. Check TOGGL_API_TOKEN.",
      402: "402: Toggl API quota used up. Wait for reset.",
      403: "403: token rejected or no access.",
      429: "429: Toggl rate limit hit. Wait a bit and retry.",
    }[res.status] || `Toggl HTTP ${res.status}`;
    throw new HttpError(502, msg);
  }
  return res.json();
}

function projectMap(list) {
  const projects = {};
  for (const p of list || []) projects[p.id] = { name: p.name, color: p.color };
  return projects;
}

function sampleData(startUtc, endUtc) {
  // Clearly fake entries for testing the layout. Seeded PRNG (mulberry32).
  let s = 42;
  const rnd = () => { s |= 0; s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const int = (a, b) => a + Math.floor(rnd() * (b - a + 1));
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const projects = {
    1: { name: "Project Alpha", color: "#4c78a8" },
    2: { name: "Project Beta", color: "#f58518" },
    3: { name: "Admin", color: "#54a24b" },
  };
  const tasks = ["Task A", "Task B", "Task C", "Meeting", "Review", ""];
  // Tags follow projects (like real data); a few untagged / multi-tag entries.
  const tagOf = { 1: ["Tag X"], 2: ["Tag Y"], 3: ["Tag Z"] };
  const entries = [];
  for (let day = startUtc; day < endUtc; day += DAY_MS) {
    let t = day + 8 * 3600e3;
    for (let i = int(0, 6); i > 0; i--) {
      const secs = int(15, 90) * 60;
      if (t > Date.now()) break; // no future entries; one spanning now = running
      const pid = pick([1, 1, 2, 3, null]);
      entries.push({ start: new Date(t).toISOString(), duration: t + secs * 1000 > Date.now() ? -1 : secs,
        project_id: pid, description: pick(tasks), tags: rnd() < 0.1 ? ["Tag X", "Tag Z"] : tagOf[pid] || [] });
      t += (secs + int(5, 40) * 60) * 1000;
    }
  }
  return { entries, projects };
}

function normalize(entries, projects, off) {
  const now = Date.now();
  return entries.map((e) => {
    const start = Date.parse(e.start);
    const running = e.duration < 0;
    const secs = running ? (now - start) / 1000 : e.duration;
    const pid = e.project_id;
    const p = projects[pid] || {};
    const color = p.color || DEFAULT_COLOR;
    return {
      start: start + off, // local ms
      hours: secs / 3600,
      project: p.name || (pid ? `Project ${pid}` : "(no project)"),
      color: HEX_COLOR.test(color) ? color : DEFAULT_COLOR,
      task: (e.description || "").trim() || "(no description)",
      tags: Array.isArray(e.tags) ? e.tags.filter((t) => typeof t === "string" && t.trim()) : [],
      running,
    };
  }).sort((a, b) => a.start - b.start);
}

// ---------- rendering ----------

const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const pad = (n) => String(n).padStart(2, "0");
const dayKey = (ms) => Math.floor(ms / DAY_MS);
const fmtDate = (ms) => { const d = new Date(ms); return `${pad(d.getUTCDate())} ${MON[d.getUTCMonth()]} ${d.getUTCFullYear()}`; };
const fmtTime = (ms) => { const d = new Date(ms); return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`; };
const fmtDow = (ms) => DOW[new Date(ms).getUTCDay()];
const fmtShort = (ms) => { const d = new Date(ms); return `${fmtDow(ms)} ${pad(d.getUTCDate())} ${MON[d.getUTCMonth()]}`; };
const fmtIso = (ms) => { const d = new Date(ms); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`; };
// Query string for one day's view; today = the "Today" tab.
const dayQuery = (d, todayLocal) => (d === todayLocal ? "days=1" : `day=${fmtIso(d)}`);
// Keep the active tag filter on a link's query string.
const tq = (qs, f) => (f.tag ? `${qs}&tag=${encodeURIComponent(f.tag)}` : qs);

// "23 – 29 Sep 2026", "02 Jul – 29 Sep 2026", "28 Dec 2025 – 03 Jan 2026"
function fmtRange(a, b) {
  const x = new Date(a), y = new Date(b);
  if (x.getUTCFullYear() !== y.getUTCFullYear()) return `${fmtDate(a)} – ${fmtDate(b)}`;
  const head = x.getUTCMonth() === y.getUTCMonth() ? pad(x.getUTCDate()) : `${pad(x.getUTCDate())} ${MON[x.getUTCMonth()]}`;
  return `${head} – ${fmtDate(b)}`;
}

function fmtH(hours) {
  const m = Math.round(hours * 60);
  return `${Math.floor(m / 60)}h ${pad(m % 60)}m`;
}

// items: [{ label, hours, color?, title? }]
function hbars(items) {
  if (!items.length) return '<p class="muted">No data.</p>';
  const top = Math.max(...items.map((x) => x.hours)) || 1;
  return items.map((x) => hrow(x, top)).join("");
}

function hrow({ label, hours, color, title }, top, extra = "") {
  return `<span class="hrow"><span class="lbl" title="${esc(title || label)}">${esc(label)}</span>` +
    `<span class="track"><span class="fill" style="width:${(hours / top * 100).toFixed(1)}%;background:${color || "var(--accent)"}"></span></span>` +
    `<span class="val">${fmtH(hours)}</span>${extra}</span>`;
}

const pctHtml = (h, total) => `<span class="pct">${(total ? h / total * 100 : 0).toFixed(1)}%</span>`;

// Rows as <details> (no JS; CSP blocks scripts): click a project to list its tasks.
function projectList(projects, total) {
  if (!projects.length) return '<p class="muted">No data.</p>';
  const top = projects[0].hours || 1;
  return projects.map((p) => {
    const tasks = [...p.tasks].sort((a, b) => b[1] - a[1])
      .map(([label, hours]) => ({ label, hours, color: p.color }));
    return `<details class="proj"><summary>${hrow(p, top, pctHtml(p.hours, total))}</summary>` +
      `<div class="sub">${hbars(tasks)}</div></details>`;
  }).join("");
}

// Tag -> project -> task, nested <details>.
function tagList(tags, total) {
  if (!tags.length) return '<p class="muted">No data.</p>';
  const top = tags[0].hours || 1;
  return tags.map((t) => `<details class="proj"><summary>${hrow(t, top, pctHtml(t.hours, total))}</summary>` +
    `<div class="sub">${projectList(t.subs, total)}</div></details>`).join("");
}

// Donut of items [{ label, hours, color }] (inline SVG, no JS). % labels outside for slices >= 4%.
function donut(items, total) {
  if (!total) return '<p class="muted">No data.</p>';
  const R = 36, C = 2 * Math.PI * R;
  let cum = 0;
  const segs = [], labels = [];
  for (const x of items) {
    const frac = x.hours / total, mid = (cum + frac / 2) * 2 * Math.PI - Math.PI / 2;
    const gap = items.length > 1 ? Math.min(0.6, frac * C / 2) : 0;
    segs.push(`<circle class="dseg" r="${R}" cx="50" cy="50" stroke="${x.color || "var(--accent)"}" ` +
      `stroke-dasharray="${(frac * C - gap).toFixed(2)} ${(C - frac * C + gap).toFixed(2)}" stroke-dashoffset="${(-cum * C).toFixed(2)}">` +
      `<title>${esc(x.label)}: ${fmtH(x.hours)} (${(frac * 100).toFixed(1)}%)</title></circle>`);
    if (frac >= 0.04) {
      const lx = 50 + 50 * Math.cos(mid), ly = 50 + 50 * Math.sin(mid);
      const anchor = Math.abs(lx - 50) < 8 ? "middle" : lx > 50 ? "start" : "end";
      labels.push(`<text x="${lx.toFixed(1)}" y="${(ly + 2).toFixed(1)}" text-anchor="${anchor}">${(frac * 100).toFixed(0)}%</text>`);
    }
    cum += frac;
  }
  const legend = items.map((x) => `<span class="lg"><span class="dot" style="background:${x.color || "var(--accent)"}"></span>` +
    `<span class="lbl" title="${esc(x.label)}">${esc(x.label)}</span><span class="val">${fmtH(x.hours)}</span>${pctHtml(x.hours, total)}</span>`).join("");
  return `<svg class="donut" viewBox="-14 -6 128 112" role="img" aria-label="Distribution chart">` +
    `<g transform="rotate(-90 50 50)">${segs.join("")}</g>${labels.join("")}` +
    `<text class="dtot" x="50" y="51" text-anchor="middle">${fmtH(total)}</text>` +
    `<text x="50" y="60" text-anchor="middle">total</text></svg><div class="legend">${legend}</div>`;
}

// List / chart switch: CSS-only (hidden radios + labels) since CSP blocks scripts.
function viewSwitch(title, hint, list, chart) {
  return `<div class="card bd"><input class="vh" type="radio" name="bdv" id="bdv-l" checked><input class="vh" type="radio" name="bdv" id="bdv-c">` +
    `<h2 class="bdh"><span>${title} <span class="muted hint">${hint}</span></span>` +
    `<span class="vsw"><label for="bdv-l">List</label><label for="bdv-c">Chart</label></span></h2>` +
    `<div class="v-list">${list}</div><div class="v-chart">${chart}</div></div>`;
}

// Unfiltered: tags with their projects. Filtered to one tag: just its projects.
function breakdownCard(rows, total, f) {
  if (f.tag) {
    const projects = groupProjects(rows);
    return viewSwitch(`Projects in ${esc(f.tag)}`, "click to see tasks", projectList(projects, total), donut(projects, total));
  }
  const tags = groupTags(rows);
  return viewSwitch("By tag", "click a tag for projects, a project for tasks", tagList(tags, total), donut(tags, total));
}

function quotaHtml(q, off) {
  if (!q) return `<span title="No Toggl call recorded yet">API quota: unknown</span>`;
  const asOf = `as of ${fmtTime(q.fetchedAt + off)}`;
  if (q.remaining === null) {
    const raw = Object.entries(q.raw || {}).map(([k, v]) => `${k}: ${v}`).join(", ");
    return raw ? `API quota: ${esc(raw)} (${asOf})`
      : `<span title="Toggl response had no quota headers">API quota: not reported (${asOf})</span>`;
  }
  let reset = "";
  if (q.resetsIn !== null) {
    const left = q.fetchedAt + q.resetsIn * 1000 - Date.now();
    reset = left > 0 ? ` · resets in ${Math.ceil(left / 60e3)}m` : " · reset since";
  }
  return `API quota: <b>${q.remaining}</b> left${reset} (${asOf})`;
}

const add = (m, k, v) => m.set(k, (m.get(k) || 0) + v);

// One piece per (entry, tag). Multi-tag entry: hours split evenly across its tags,
// so tag totals (list and chart) add up to the real total.
function splitTags(rows) {
  return rows.flatMap((r) => {
    const ts = r.tags.length ? [...new Set(r.tags)] : [NO_TAG];
    return ts.map((tag) => ({ ...r, tag, hours: r.hours / ts.length }));
  });
}

// [{ label, hours, color, subs: [project rows] }], largest first.
// Toggl tags have no color: use the tag's top project's color.
function groupTags(rows) {
  const byTag = new Map();
  for (const p of splitTags(rows)) {
    if (!byTag.has(p.tag)) byTag.set(p.tag, []);
    byTag.get(p.tag).push(p);
  }
  return [...byTag].map(([label, tagRows]) => {
    const subs = groupProjects(tagRows);
    return { label, hours: subs.reduce((a, p) => a + p.hours, 0), color: subs[0].color, subs };
  }).sort((a, b) => b.hours - a.hours);
}

// [{ label, hours, color, tasks: Map(task -> hours) }], largest first.
function groupProjects(rows) {
  const byProject = new Map();
  for (const r of rows) {
    if (!byProject.has(r.project)) byProject.set(r.project, { label: r.project, hours: 0, color: r.color, tasks: new Map() });
    const p = byProject.get(r.project);
    p.hours += r.hours;
    add(p.tasks, r.task, r.hours);
  }
  return [...byProject.values()].sort((a, b) => b.hours - a.hours);
}

// days = active range tab (0 = none); self = query string of this view, for refresh.
function headerHtml(days, self, off, data, quota, f) {
  const fetched = data.fetchedAt + off;
  const status = `data ${data.cached ? "cached" : "fetched"} ${fmtDate(fetched)} ${fmtTime(fetched)}` +
    (data.stale ? ` <span class="warn">· old data, Toggl refused refresh: ${esc(data.stale)}</span>` : "");
  const rangeLinks = [[1, "Today"], [7, "7d"], [14, "14d"], [30, "30d"], [90, "90d"]].map(([n, label]) =>
    n === days ? `<b>${label}</b>` : `<a href="?${tq(`days=${n}`, f)}">${label}</a>`).join(" · ");
  const names = f.tag && !f.tags.includes(f.tag) ? [...f.tags, f.tag] : f.tags;
  const tagLinks = [f.tag ? `<a href="?${self}">All</a>` : "<b>All</b>", ...names.map((t) =>
    t === f.tag ? `<b>${esc(t)}</b>` : `<a href="?${self}&tag=${encodeURIComponent(t)}">${esc(t)}</a>`)].join(" · ");
  return `<header><h1>Toggl Dashboard</h1>
<div class="muted">${status} · <a href="?${tq(self, f)}&refresh=1">refresh</a> · ${quota}</div>
<nav class="muted">${rangeLinks}</nav>
${names.length ? `<nav class="muted tagnav">Tag: ${tagLinks}</nav>` : ""}</header>`;
}

function render(rows, startLocal, days, off, data, quota, f) {
  const byDay = new Map(), byTask = new Map();
  // Chart stacks by tag; when filtered to one tag, by project.
  for (const p of f.tag ? rows.map((r) => ({ ...r, tag: r.project })) : splitTags(rows)) {
    const d = dayKey(p.start);
    if (!byDay.has(d)) byDay.set(d, new Map());
    add(byDay.get(d), p.tag, p.hours);
  }
  for (const r of rows) {
    // Same description under different projects = different tasks.
    const tk = `${r.project}\u0000${r.task}`;
    if (!byTask.has(tk)) byTask.set(tk, { label: r.task, hours: 0, title: `${r.task} · ${r.project}`,
      color: r.project === "(no project)" ? null : r.color });
    byTask.get(tk).hours += r.hours;
  }
  const projects = groupProjects(rows);
  const total = projects.reduce((a, p) => a + p.hours, 0);
  const sum = (m) => [...m.values()].reduce((a, b) => a + b, 0);
  const activeDays = [...byDay.values()].filter((m) => sum(m) > 0).length;
  const tasks = [...byTask.values()].sort((a, b) => b.hours - a.hours).slice(0, 10);
  const stack = f.tag ? projects : groupTags(rows);

  const dayList = Array.from({ length: days }, (_, i) => startLocal + i * DAY_MS);
  const dm = (d) => byDay.get(dayKey(d)) || new Map();
  const dh = (d) => sum(dm(d));
  const dayMax = Math.max(...dayList.map(dh), 0.01);
  // Stacked in list order (largest overall at bottom).
  const end = startLocal + (days - 1) * DAY_MS; // = today
  const dayCols = dayList.map((d) => {
    const m = dm(d), h = dh(d);
    const segs = stack.filter((p) => m.get(p.label) > 0).map((p) =>
      `<span class="seg" style="height:${(m.get(p.label) / h * 100).toFixed(2)}%;background:${p.color}" ` +
      `title="${fmtShort(d)} · ${esc(p.label)}: ${fmtH(m.get(p.label))}"></span>`).join("");
    return `<a class="col" href="?${tq(dayQuery(d, end), f)}" title="${fmtShort(d)}: ${fmtH(h)} · click for day view">` +
      `<span class="colval">${h ? h.toFixed(1) : "&nbsp;"}</span>` +
      `<span class="bar" style="height:${(h / dayMax * 100).toFixed(1)}%">${segs}</span>` +
      `<span class="collbl">${pad(new Date(d).getUTCDate())}<br>${fmtDow(d)}</span></a>`;
  }).join("");

  return `${headerHtml(days, `days=${days}`, off, data, quota, f)}
<section class="kpis">
  <div class="card kpi"><span class="muted">Period (${days}d)</span><b class="sm">${fmtRange(startLocal, end)}</b></div>
  <div class="card kpi"><span class="muted">Total tracked</span><b>${fmtH(total)}</b></div>
  <div class="card kpi"><span class="muted">Avg per active day</span><b>${fmtH(activeDays ? total / activeDays : 0)}</b></div>
  <div class="card kpi"><span class="muted">Entries</span><b>${rows.length}</b></div>
</section>
<section class="card"><h2>Hours per day <span class="muted hint">click a day for details</span></h2><div class="dayscroll"><div class="days">${dayCols}</div></div></section>
<section class="two">
  ${breakdownCard(rows, total, f)}
  <div class="card"><h2>Top tasks</h2>${hbars(tasks)}</div>
</section>`;
}

// One day (today via days=1, or ?day=YYYY-MM-DD): timeline + log instead of per-day totals.
function renderDay(rows, all, dayStart, todayLocal, off, data, quota, f) {
  const isToday = dayStart === todayLocal;
  const nowLocal = Date.now() + off;
  const endOf = (r) => r.start + r.hours * 3600e3;
  const total = rows.reduce((a, r) => a + r.hours, 0);
  const projects = groupProjects(rows);

  // Compare with previous 7 days, active days only (so days off don't drag the average down).
  const prev = new Map();
  for (const r of all) if (r.start >= dayStart - 7 * DAY_MS && r.start < dayStart) add(prev, dayKey(r.start), r.hours);
  const avg = prev.size ? [...prev.values()].reduce((a, b) => a + b, 0) / prev.size : 0;
  const diff = total - avg;
  const vsAvg = prev.size
    ? `<span class="${diff >= 0 ? "up" : "down"}">${diff >= 0 ? "+" : "−"}${fmtH(Math.abs(diff))}</span> vs 7d avg ${fmtH(avg)}`
    : "no data in previous 7 days";

  const first = rows[0], lastEnd = rows.length ? Math.max(...rows.map(endOf)) : 0;
  const span = rows.length ? lastEnd - first.start : 0;
  const running = rows.find((r) => r.running);
  const nowKpi = running
    ? `<b class="sm"><span class="live"></span>${esc(running.task)}</b><small class="muted">${esc(running.project)} · ${fmtH(running.hours)} so far</small>`
    : `<b>Idle</b><small class="muted">${rows.length ? `last stopped ${fmtTime(lastEnd)}` : "nothing tracked yet"}</small>`;
  const top = f.tag ? projects[0] : groupTags(rows)[0];
  const topKpi = top
    ? `<b class="sm"><span class="dot" style="background:${top.color}"></span>${esc(top.label)}</b><small class="muted">${fmtH(top.hours)} · ${Math.round(top.hours / total * 100)}% of day</small>`
    : `<b>–</b><small class="muted">nothing tracked</small>`;

  // Timeline window: at least 08–18, widened to fit entries and now; whole hours.
  const hr = (ms) => (ms - dayStart) / 3600e3;
  const h0 = Math.max(0, Math.min(8, rows.length ? Math.floor(hr(first.start)) : 8));
  const h1 = Math.min(24, Math.max(18, Math.ceil(Math.max(hr(lastEnd), isToday ? hr(nowLocal) : 0))));
  const winStart = dayStart + h0 * 3600e3, winMs = (h1 - h0) * 3600e3;
  const pos = (ms) => ((Math.min(Math.max(ms, winStart), winStart + winMs) - winStart) / winMs * 100).toFixed(2);
  const blocks = rows.map((r) => {
    const l = pos(r.start), w = Math.max(pos(endOf(r)) - l, 0.4);
    return `<span class="blk${r.running ? " run" : ""}" style="left:${l}%;width:${w.toFixed(2)}%;background:${r.color}" ` +
      `title="${fmtTime(r.start)}–${r.running ? "now" : fmtTime(endOf(r))} · ${esc(r.project)} · ${esc(r.task)} (${fmtH(r.hours)})"></span>`;
  }).join("");
  const step = h1 - h0 > 12 ? 2 : 1;
  const ticks = Array.from({ length: Math.floor((h1 - h0) / step) + 1 }, (_, i) => h0 + i * step)
    .map((h) => `<span class="tick" style="left:${((h - h0) / (h1 - h0) * 100).toFixed(2)}%">${pad(h)}</span>`).join("");
  const nowMark = isToday && nowLocal >= winStart && nowLocal <= winStart + winMs
    ? `<span class="now" style="left:${pos(nowLocal)}%" title="now ${fmtTime(nowLocal)}"></span>` : "";

  const log = rows.slice().reverse().map((r) =>
    `<tr${r.running ? ' class="running"' : ""}><td class="num">${fmtTime(r.start)}–${r.running ? "now" : fmtTime(endOf(r))}</td>` +
    `<td><span class="dot" style="background:${r.color}"></span>${esc(r.project)}</td>` +
    `<td>${esc(r.task)}</td><td class="num">${fmtH(r.hours)}</td></tr>`).join("");

  const oldest = todayLocal - (MAX_DAYS - 1) * DAY_MS;
  const prevLink = dayStart > oldest ? `<a href="?${tq(dayQuery(dayStart - DAY_MS, todayLocal), f)}">‹ ${fmtShort(dayStart - DAY_MS)}</a>` : "<span></span>";
  const nextLink = isToday ? "<span></span>" : `<a href="?${tq(dayQuery(dayStart + DAY_MS, todayLocal), f)}">${fmtShort(dayStart + DAY_MS)} ›</a>`;

  return `${headerHtml(isToday ? 1 : 0, dayQuery(dayStart, todayLocal), off, data, quota, f)}
<nav class="daynav">${prevLink}<b>${isToday ? "Today · " : ""}${fmtShort(dayStart)} ${new Date(dayStart).getUTCFullYear()}</b>${nextLink}</nav>
<section class="kpis">
  <div class="card kpi"><span class="muted">Tracked</span><b>${fmtH(total)}</b><small class="muted">${vsAvg}</small></div>
  <div class="card kpi"><span class="muted">Day span</span><b>${rows.length ? `${fmtTime(first.start)} – ${running ? "now" : fmtTime(lastEnd)}` : "–"}</b>` +
    `<small class="muted">${span ? `${Math.round(total * 3600e3 / span * 100)}% of span tracked · ${rows.length} entries` : "&nbsp;"}</small></div>
  ${isToday ? `<div class="card kpi"><span class="muted">Now</span>${nowKpi}</div>`
    : `<div class="card kpi"><span class="muted">Top ${f.tag ? "project" : "tag"}</span>${topKpi}</div>`}
</section>
<section class="card"><h2>Timeline <span class="muted hint">gaps = untracked</span></h2>
  ${rows.length ? `<div class="tl">${blocks}${nowMark}</div><div class="ticks">${ticks}</div>` : `<p class="muted">Nothing tracked ${isToday ? "yet today" : "this day"}.</p>`}
</section>
<section class="two">
  ${breakdownCard(rows, total, f)}
  <div class="card"><h2>Entries</h2><div class="tablewrap"><table>${log || '<tr><td class="muted">No entries.</td></tr>'}</table></div></div>
</section>`;
}

function errorHtml(msg, quota) {
  return `<header><h1>Toggl Dashboard</h1><div class="muted">${quota}</div></header>
<section class="card"><h2>Error</h2><p>${esc(msg)}</p><p><a href="?refresh=1">Retry</a></p></section>`;
}

function page(body, status = 200) {
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Toggl Dashboard</title>
<style>${CSS}</style></head>
<body><main>${body}</main></body></html>`;
  return new Response(html, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "private, no-store",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    },
  });
}

const CSS = `
:root { --bg:#f6f7f9; --card:#fff; --text:#1d2129; --muted:#6b7280; --line:#e5e7eb; --accent:#4c78a8; }
@media (prefers-color-scheme: dark) {
  :root { --bg:#111418; --card:#1b1f25; --text:#e6e8eb; --muted:#9aa1ab; --line:#2c323a; --accent:#7aa6d6; }
}
* { box-sizing:border-box; }
body { margin:0; padding:24px 16px; background:var(--bg); color:var(--text);
  font:14px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif; }
main { max-width:1100px; margin:0 auto; display:grid; gap:16px; }
h1 { margin:0; font-size:22px; } h2 { margin:0 0 12px; font-size:15px; }
a { color:var(--accent); }
.muted { color:var(--muted); }
.warn { color:#d97706; }
.card { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:16px; min-width:0; }
.kpis { display:grid; grid-template-columns:repeat(auto-fit,minmax(160px,1fr)); gap:16px; }
.kpi b { display:block; font-size:18px; margin-top:4px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
/* Period text is longest: wrap instead of ellipsis on narrow screens. */
.kpi b.sm { white-space:normal; }
.two { display:grid; grid-template-columns:repeat(auto-fit,minmax(min(320px,100%),1fr)); gap:16px; }
/* >~30 days: columns keep min width and the chart scrolls. rtl container = starts scrolled to latest day (no JS). */
.dayscroll { overflow-x:auto; direction:rtl; padding-bottom:4px; }
.days { direction:ltr; display:flex; align-items:flex-end; gap:4px; height:200px; min-width:100%; width:max-content; }
.col { flex:1 0 30px; height:100%; display:flex; flex-direction:column; justify-content:flex-end; align-items:center; }
.bar { width:100%; max-width:36px; border-radius:4px 4px 0 0; min-height:1px; overflow:hidden;
  display:flex; flex-direction:column-reverse; }
.seg { display:block; width:100%; flex:none; transition:opacity .12s, filter .12s; }
.bar:hover .seg { opacity:.45; }
.bar .seg:hover { opacity:1; filter:brightness(1.35) saturate(1.2); box-shadow:inset 0 0 0 1px rgba(255,255,255,.7); }
.colval, .collbl { font-size:11px; color:var(--muted); text-align:center; }
.collbl { margin-top:4px; line-height:1.2; }
.hrow { display:grid; grid-template-columns:minmax(0,180px) 1fr auto; gap:8px; align-items:center; margin:6px 0; }
.lbl { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.track { background:var(--line); border-radius:4px; height:12px; overflow:hidden; }
.fill { display:block; height:100%; border-radius:4px; }
.val, .num, .pct { font-variant-numeric:tabular-nums; white-space:nowrap; }
.hint { font-weight:normal; font-size:12px; margin-left:6px; }
.proj > summary { list-style:none; cursor:pointer; border-radius:6px; }
.proj > summary::-webkit-details-marker { display:none; }
.proj > summary:hover { background:var(--line); }
.proj > summary:focus-visible { outline:2px solid var(--accent); }
.proj > summary .hrow { grid-template-columns:minmax(0,180px) 1fr auto 48px; }
.proj > summary .lbl::before { content:"▸ "; color:var(--muted); }
.proj[open] > summary .lbl::before { content:"▾ "; }
.tagnav { font-size:13px; }
.pct { color:var(--muted); text-align:right; }
.sub { margin:2px 0 10px 16px; padding-left:10px; border-left:2px solid var(--line); font-size:13px; }
.tablewrap { overflow-x:auto; }
table { width:100%; border-collapse:collapse; }
td { padding:6px 8px; border-top:1px solid var(--line); vertical-align:top; }
.num { text-align:right; }
.dot { display:inline-block; width:8px; height:8px; border-radius:50%; margin-right:6px; }
/* Day view */
a.col { color:inherit; text-decoration:none; border-radius:4px; }
a.col:hover .collbl, a.col:focus-visible .collbl { color:var(--accent); font-weight:600; }
a.col:focus-visible { outline:2px solid var(--accent); }
.daynav { display:flex; justify-content:space-between; align-items:center; gap:8px; }
.daynav b { font-size:16px; text-align:center; }
.kpi small { display:block; margin-top:2px; font-size:12px; }
.up { color:#16a34a; } .down { color:#dc2626; }
.live { display:inline-block; width:9px; height:9px; border-radius:50%; background:#dc2626; margin-right:6px;
  animation:pulse 1.6s ease-in-out infinite; }
@keyframes pulse { 50% { opacity:.3; } }
.tl { position:relative; height:44px; background:var(--line); border-radius:6px; overflow:hidden; }
.blk { position:absolute; top:0; bottom:0; border-right:1px solid var(--card); transition:filter .12s; }
.blk:hover { filter:brightness(1.3); }
.blk.run { background-image:repeating-linear-gradient(45deg,transparent 0 6px,rgba(255,255,255,.25) 6px 12px); }
.now { position:absolute; top:-2px; bottom:-2px; width:2px; margin-left:-1px; background:var(--text); }
.ticks { position:relative; height:18px; margin-top:4px; font-size:11px; color:var(--muted); }
.tick { position:absolute; transform:translateX(-50%); font-variant-numeric:tabular-nums; }
.tick:first-child { transform:none; } .tick:last-child { transform:translateX(-100%); }
tr.running td { font-weight:600; }
/* Breakdown list / chart switch */
.vh { position:absolute; opacity:0; width:1px; height:1px; pointer-events:none; }
.bd { position:relative; }
.bdh { display:flex; justify-content:space-between; align-items:center; gap:8px; flex-wrap:wrap; }
.vsw { display:inline-flex; border:1px solid var(--line); border-radius:6px; overflow:hidden; font-weight:normal; font-size:12px; }
.vsw label { padding:3px 10px; cursor:pointer; color:var(--muted); }
.vsw label:hover { background:var(--line); }
#bdv-l:checked ~ .bdh label[for=bdv-l], #bdv-c:checked ~ .bdh label[for=bdv-c] { background:var(--accent); color:var(--card); }
#bdv-l:focus-visible ~ .bdh label[for=bdv-l], #bdv-c:focus-visible ~ .bdh label[for=bdv-c] { outline:2px solid var(--accent); outline-offset:1px; }
.v-chart { display:none; }
#bdv-c:checked ~ .v-chart { display:block; }
#bdv-c:checked ~ .v-list { display:none; }
.donut { display:block; width:100%; max-width:320px; margin:0 auto; font-size:5px; fill:var(--muted); }
.dseg { fill:none; stroke-width:11; transition:opacity .12s, filter .12s; }
.donut:hover .dseg { opacity:.45; }
.donut .dseg:hover { opacity:1; filter:brightness(1.3); }
.dtot { font-size:9px; font-weight:600; fill:var(--text); font-variant-numeric:tabular-nums; }
.legend { margin-top:8px; }
.lg { display:grid; grid-template-columns:auto minmax(0,1fr) auto 48px; gap:8px; align-items:center; margin:4px 0; }
.lg .dot { margin:0; }
`;

// ---------- Cloudflare Access JWT check ----------

let jwks = null, jwksAt = 0;

const b64url = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

// Returns null if OK, else a short reason (logged, never sent to client).
async function verifyAccess(req, env) {
  const team = env.ACCESS_TEAM_DOMAIN, aud = env.ACCESS_AUD;
  if (!team || !aud) return "ACCESS_TEAM_DOMAIN/ACCESS_AUD not set"; // fail closed
  const token = req.headers.get("Cf-Access-Jwt-Assertion");
  if (!token) return "no Cf-Access-Jwt-Assertion header";
  try {
    const [h, p, sig] = token.split(".");
    const dec = new TextDecoder();
    const header = JSON.parse(dec.decode(b64url(h)));
    const claims = JSON.parse(dec.decode(b64url(p)));
    const auds = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (header.alg !== "RS256") return `alg ${header.alg}`;
    if (!auds.includes(aud)) return "aud mismatch";
    if (claims.iss !== `https://${team}`) return `iss mismatch: got ${claims.iss}`;
    if (!claims.exp || claims.exp * 1000 < Date.now()) return "token expired";
    if (env.ALLOWED_EMAIL && (claims.email || "").toLowerCase() !== env.ALLOWED_EMAIL.toLowerCase()) return "email not allowed";

    if (!jwks || Date.now() - jwksAt > 3600e3) {
      const r = await fetch(`https://${team}/cdn-cgi/access/certs`);
      if (!r.ok) return `certs HTTP ${r.status}`;
      jwks = (await r.json()).keys || [];
      jwksAt = Date.now();
    }
    const jwk = jwks.find((k) => k.kid === header.kid);
    if (!jwk) return "kid not in JWKS";
    const key = await crypto.subtle.importKey("jwk", jwk,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64url(sig),
      new TextEncoder().encode(`${h}.${p}`));
    return ok ? null : "bad signature";
  } catch (e) {
    return `verify error: ${e.message}`;
  }
}
