# Toggl Dashboard

Personal Toggl Track dashboard running as a Cloudflare Worker behind Cloudflare Access.

**Live:** https://toggl-dashboard.penk13.workers.dev/ (login required)

## Features
- Range views (`?days=7|14|30|90`) and day view (`?day=YYYY-MM-DD`)
- Time by tag → project → task, list or donut chart
- Tag filter (`?tag=Name`), hours-per-day chart
- Cached Toggl data (10 min fresh, `?refresh=1` to force); `?sample=1` for fake data

## Files
- `worker.js` — Worker (no deps)
- `wrangler.toml` — Worker config
- `toggl_dashboard.py` — original local Python version (stdlib only)

## Deploy
```sh
npx wrangler secret put TOGGL_API_TOKEN
npx wrangler deploy
```

Local dev: copy `.dev.vars.example` to `.dev.vars`, then `npx wrangler dev`.
