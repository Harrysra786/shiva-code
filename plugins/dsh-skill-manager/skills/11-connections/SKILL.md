---
name: 11-connections
description: Use the machine's connection CLIs (GitHub, Supabase, Railway, Vercel) through the agent tools — check status, install the CLI, log in (browser or token), run actions (deploy/redeploy/open dashboard), and bring the provider tab to the front.
whenToUse: When the plan or build needs a real repo, database, deploy or hosting connection (typically /04-tech-plan, /07-build, /08-review).
---

# Connections (GitHub · Supabase · Railway · Vercel)

Four tools drive the workspace's connection CLIs, one per provider: `github_cli`, `supabase_cli`, `railway_cli`, `vercel_cli`. They expose the same buttons as the provider's sidebar tab, so the agent operates the connection itself — the human never has to click, and never has to open the tab.

## The tool

Every tool takes `op` (required) plus optional args:

| `op` | Args | Effect |
|---|---|---|
| `status` | — | CLI installed/version, login state + account, workspace link (project/service), status items, **available actions**, install job, login progress |
| `install` | — | Install the provider CLI (npm/scoop/brew chain); poll with `job` |
| `login` | `token?` | Start the browser login **and open it**; pass `token` to save an access token instead |
| `login_input` | `text?` | Answer a login prompt (default Enter) |
| `logout` | — | Disconnect |
| `action` | `action` | Run an action id from `status` (e.g. Railway `up`, `redeploy`, `open`); an `open` result also opens the browser |
| `open` | `url?` | Open a URL in the browser (login or dashboard); defaults to the login URL or the workspace dashboard |
| `focus` | — | Bring the provider's tab to the front |
| `job` | — | Install job progress |

## Flow

1. **Always `status` first.** It says what is installed, whether the account is connected, whether this workspace is linked, and which `action` ids exist. The `action` list is authoritative — never invent one.
2. **Not installed → `install`**, then poll `job` until `phase` is `done` or `error`.
3. **Not logged in → `login`.** The browser opens at the provider's OAuth page and the tool returns the `url`/`code`; the human authorizes once. If the CLI has no browser flow, pass `token` (ask the human for it). Use `login_input` when the CLI prompts.
4. **Run actions by id** (`action`). A deploy is `railway_cli {op:'action', action:'up'}`; the dashboard is `... action:'open'`.
5. **`focus`** when the human should watch the tab.

## Rules

- The project link lives in the workspace; never deploy from another directory.
- A deploy is the human's decision — confirm the target before `action up`.
- Report the CLI's real output; never claim a deploy succeeded without it. `/08-review` verifies the deployed URL, not the exit code.
