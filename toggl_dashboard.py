"""Fetch Toggl Track time entries and render a simple local HTML dashboard.

Setup (once):  setx TOGGL_API_TOKEN "<your token from Toggl > Profile > API Token>"
Usage:
    python toggl_dashboard.py              # last 14 days, opens browser
    python toggl_dashboard.py --days 30
    python toggl_dashboard.py --sample     # fake data, no API call

Read-only: only GET requests are made. Standard library only.
"""
import argparse
import base64
import html
import json
import os
import random
import re
import sys
import webbrowser
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

API = "https://api.track.toggl.com/api/v9"
OUT = Path(__file__).with_name("dashboard.html")
DEFAULT_COLOR = "#8a8f98"
HEX_COLOR = re.compile(r"^#[0-9a-fA-F]{6}$")


def local_tz():
    # Fixed offset (Asia/Jakarta = +7, no DST); avoids needing tzdata on Windows.
    return timezone(timedelta(hours=float(os.environ.get("TOGGL_UTC_OFFSET", "7"))))


def api_get(path, token, params=None):
    url = f"{API}{path}" + (f"?{urlencode(params)}" if params else "")
    auth = base64.b64encode(f"{token}:api_token".encode()).decode()
    req = Request(url, headers={"Authorization": f"Basic {auth}", "Accept": "application/json"})
    with urlopen(req, timeout=30) as resp:
        return json.load(resp)


def fetch(token, start, end):
    entries = api_get("/me/time_entries", token,
                      {"start_date": start.isoformat(), "end_date": end.isoformat()}) or []
    try:
        projects = {p["id"]: p for p in api_get("/me/projects", token) or []}
    except HTTPError:
        projects = {}  # dashboard still works, just shows project ids
    return entries, projects


def sample_data(start, end):
    """Clearly fake entries for testing the layout."""
    rng = random.Random(42)
    projects = {1: {"name": "Project Alpha", "color": "#4c78a8"},
                2: {"name": "Project Beta", "color": "#f58518"},
                3: {"name": "Admin", "color": "#54a24b"}}
    tasks = ["Task A", "Task B", "Task C", "Meeting", "Review", ""]
    entries, day = [], start
    while day < end:
        t = day.replace(hour=8)
        for _ in range(rng.randint(0, 6)):
            secs = rng.randint(15, 90) * 60
            entries.append({"start": t.astimezone(timezone.utc).isoformat(), "duration": secs,
                            "project_id": rng.choice([1, 1, 2, 3, None]),
                            "description": rng.choice(tasks)})
            t += timedelta(seconds=secs + rng.randint(5, 40) * 60)
        day += timedelta(days=1)
    return entries, projects


def normalize(entries, projects, tz):
    now = datetime.now(timezone.utc)
    rows = []
    for e in entries:
        start = datetime.fromisoformat(e["start"].replace("Z", "+00:00"))
        running = e["duration"] < 0
        secs = (now - start).total_seconds() if running else e["duration"]
        pid = e.get("project_id")
        p = projects.get(pid, {})
        color = p.get("color") or DEFAULT_COLOR
        rows.append({
            "start": start.astimezone(tz),
            "hours": secs / 3600,
            "project": p.get("name") or (f"Project {pid}" if pid else "(no project)"),
            "color": color if HEX_COLOR.match(color) else DEFAULT_COLOR,
            "task": (e.get("description") or "").strip() or "(no description)",
            "running": running,
        })
    return sorted(rows, key=lambda r: r["start"])


def fmt_h(hours):
    h, m = divmod(round(hours * 60), 60)
    return f"{h}h {m:02d}m"


def hbars(items, colors=None):
    """items: list of (label, hours). Horizontal bar rows."""
    if not items:
        return '<p class="muted">No data.</p>'
    top = max(h for _, h in items) or 1
    out = []
    for label, h in items:
        color = (colors or {}).get(label, "var(--accent)")
        out.append(
            f'<div class="hrow"><span class="lbl" title="{html.escape(label)}">{html.escape(label)}</span>'
            f'<span class="track"><span class="fill" style="width:{h / top * 100:.1f}%;background:{color}"></span></span>'
            f'<span class="val">{fmt_h(h)}</span></div>')
    return "".join(out)


def render(rows, start, days):
    by_day = defaultdict(float)
    by_project = defaultdict(float)
    by_task = defaultdict(float)
    colors = {}
    for r in rows:
        by_day[r["start"].date()] += r["hours"]
        by_project[r["project"]] += r["hours"]
        by_task[r["task"]] += r["hours"]
        colors[r["project"]] = r["color"]

    total = sum(by_project.values())
    active_days = sum(1 for v in by_day.values() if v > 0)
    top_project = max(by_project, key=by_project.get) if by_project else "-"

    day_list = [(start + timedelta(days=i)).date() for i in range(days)]
    day_max = max([by_day[d] for d in day_list] + [0.01])
    day_cols = "".join(
        f'<div class="col" title="{d:%a %d %b}: {fmt_h(by_day[d])}">'
        f'<span class="colval">{by_day[d]:.1f}</span>'
        f'<span class="bar" style="height:{by_day[d] / day_max * 100:.1f}%"></span>'
        f'<span class="collbl">{d:%d}<br>{d:%a}</span></div>'
        for d in day_list)

    projects = sorted(by_project.items(), key=lambda kv: -kv[1])
    tasks = sorted(by_task.items(), key=lambda kv: -kv[1])[:10]
    recent = "".join(
        f'<tr><td>{r["start"]:%a %d %b %H:%M}</td>'
        f'<td><span class="dot" style="background:{r["color"]}"></span>{html.escape(r["project"])}</td>'
        f'<td>{html.escape(r["task"])}{" <b>(running)</b>" if r["running"] else ""}</td>'
        f'<td class="num">{fmt_h(r["hours"])}</td></tr>'
        for r in reversed(rows[-15:]))

    end = start + timedelta(days=days - 1)
    return f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Toggl Dashboard</title>
<style>
:root {{ --bg:#f6f7f9; --card:#fff; --text:#1d2129; --muted:#6b7280; --line:#e5e7eb; --accent:#4c78a8; }}
@media (prefers-color-scheme: dark) {{
  :root {{ --bg:#111418; --card:#1b1f25; --text:#e6e8eb; --muted:#9aa1ab; --line:#2c323a; --accent:#7aa6d6; }}
}}
* {{ box-sizing:border-box; }}
body {{ margin:0; padding:24px 16px; background:var(--bg); color:var(--text);
  font:14px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif; }}
main {{ max-width:1100px; margin:0 auto; display:grid; gap:16px; }}
h1 {{ margin:0; font-size:22px; }} h2 {{ margin:0 0 12px; font-size:15px; }}
.muted {{ color:var(--muted); }}
.card {{ background:var(--card); border:1px solid var(--line); border-radius:10px; padding:16px; min-width:0; }}
.kpis {{ display:grid; grid-template-columns:repeat(auto-fit,minmax(160px,1fr)); gap:16px; }}
.kpi b {{ display:block; font-size:24px; margin-top:4px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }}
.two {{ display:grid; grid-template-columns:repeat(auto-fit,minmax(320px,1fr)); gap:16px; }}
.days {{ display:flex; align-items:flex-end; gap:4px; height:200px; }}
.col {{ flex:1; min-width:0; height:100%; display:flex; flex-direction:column; justify-content:flex-end; align-items:center; }}
.bar {{ width:100%; max-width:36px; background:var(--accent); border-radius:4px 4px 0 0; min-height:1px; }}
.colval, .collbl {{ font-size:11px; color:var(--muted); text-align:center; }}
.collbl {{ margin-top:4px; line-height:1.2; }}
.hrow {{ display:grid; grid-template-columns:minmax(0,140px) 1fr auto; gap:8px; align-items:center; margin:6px 0; }}
.lbl {{ overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }}
.track {{ background:var(--line); border-radius:4px; height:12px; overflow:hidden; }}
.fill {{ display:block; height:100%; border-radius:4px; }}
.val, .num {{ font-variant-numeric:tabular-nums; white-space:nowrap; }}
.tablewrap {{ overflow-x:auto; }}
table {{ width:100%; border-collapse:collapse; }}
td {{ padding:6px 8px; border-top:1px solid var(--line); vertical-align:top; }}
.num {{ text-align:right; }}
.dot {{ display:inline-block; width:8px; height:8px; border-radius:50%; margin-right:6px; }}
</style></head>
<body><main>
<header><h1>Toggl Dashboard</h1>
<div class="muted">{start:%d %b %Y} – {end:%d %b %Y} · generated {datetime.now(start.tzinfo):%d %b %Y %H:%M}</div></header>
<section class="kpis">
  <div class="card kpi"><span class="muted">Total tracked</span><b>{fmt_h(total)}</b></div>
  <div class="card kpi"><span class="muted">Avg per active day</span><b>{fmt_h(total / active_days if active_days else 0)}</b></div>
  <div class="card kpi"><span class="muted">Entries</span><b>{len(rows)}</b></div>
  <div class="card kpi"><span class="muted">Top project</span><b title="{html.escape(top_project)}">{html.escape(top_project)}</b></div>
</section>
<section class="card"><h2>Hours per day</h2><div class="days">{day_cols}</div></section>
<section class="two">
  <div class="card"><h2>By project</h2>{hbars(projects, colors)}</div>
  <div class="card"><h2>Top tasks</h2>{hbars(tasks)}</div>
</section>
<section class="card"><h2>Recent entries</h2><div class="tablewrap"><table>{recent or '<tr><td class="muted">No entries.</td></tr>'}</table></div></section>
</main></body></html>"""


def main():
    ap = argparse.ArgumentParser(description="Toggl Track -> local HTML dashboard")
    ap.add_argument("--days", type=int, default=14, help="how many days back, incl. today (default 14)")
    ap.add_argument("--sample", action="store_true", help="use fake data, no API call")
    ap.add_argument("--no-open", action="store_true", help="don't open the browser")
    args = ap.parse_args()
    if args.days < 1:
        sys.exit("--days must be >= 1")

    tz = local_tz()
    today = datetime.now(tz).replace(hour=0, minute=0, second=0, microsecond=0)
    start = today - timedelta(days=args.days - 1)
    end = today + timedelta(days=1)

    if args.sample:
        entries, projects = sample_data(start, end)
    else:
        token = os.environ.get("TOGGL_API_TOKEN")
        if not token:
            sys.exit("TOGGL_API_TOKEN not set. Run: setx TOGGL_API_TOKEN \"<token>\" then open a new terminal.")
        try:
            entries, projects = fetch(token, start, end)
        except HTTPError as e:
            sys.exit({401: "401: token rejected. Check TOGGL_API_TOKEN.",
                      403: "403: token rejected or no access.",
                      429: "429: rate limited. Wait a bit and retry."}.get(e.code, f"HTTP {e.code}: {e.reason}"))
        except URLError as e:
            sys.exit(f"Network error: {e.reason}")

    rows = normalize(entries, projects, tz)
    OUT.write_text(render(rows, start, args.days), encoding="utf-8")
    print(f"{len(rows)} entries, {fmt_h(sum(r['hours'] for r in rows))} -> {OUT}")
    if not args.no_open:
        webbrowser.open(OUT.resolve().as_uri())


if __name__ == "__main__":
    main()
