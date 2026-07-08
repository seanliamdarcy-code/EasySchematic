# EasySchematic Codex Workflow

This repository prefers a low-token, high-quality workflow:

- Use Codex for planning, scoping, review, verification, and final judgment.
- Prefer the smallest working change that matches existing repository patterns.
- Use Ponytail-style decisions for coding tasks: reuse existing code, prefer
  stdlib/native features, avoid speculative abstractions, and keep diffs tight.

## Command Output

- Prefer `rtk <command>` for external commands so shell output is filtered before
  Codex reads it.
- Prefer WSL or Git Bash for Unix-style tooling when available. Use PowerShell
  mainly for native Windows tasks, package installs, or admin work.
- Keep command output narrow. Avoid large logs and broad file dumps unless they
  are required.
- Prefer focused reads and searches such as `rg`, exact file paths, and targeted
  test commands.

## Local Worker Delegation

For bounded implementation work, prefer the local worker:

```powershell
local-agent "task brief here" path\to\file1 path\to\file2
```

Default local model:

```text
ollama/qwen2.5-coder:14b
```

Delegate when:

- The task can be described in a short brief.
- The edit surface is limited to a small file set.
- Codex can review the resulting diff before commit.

Do not delegate when:

- The task is ambiguous, risky, security-sensitive, or destructive.
- The task needs product judgment, architecture decisions, or current web
  research before implementation.
- The user explicitly wants Codex to implement directly.

## Verification

After local-agent edits, Codex should:

- Review `git diff`.
- Run the smallest relevant validation command.
- Tighten or correct weak edits before finalizing.

## Project Notes

- Follow the existing React, TypeScript, Vite, and Zustand patterns already in
  the repo.
- Keep frontend changes consistent with the existing product UI and AV-focused
  workflow.
- Avoid unrelated refactors during feature or bug-fix work.

## Local Machine Setup

- Local workspace: `C:\Users\seanl\Documents\EasySchematic`.
- GitHub fork: `https://github.com/seanliamdarcy-code/EasySchematic`.
- Local GitHub auth should use `gh` / Git Credential Manager as
  `seanliamdarcy-code`.
- Do not push to GitHub unless Sean explicitly asks for a push.
- Local-only operational files are ignored via `.git/info/exclude`:
  `vps-snapshots/` and `terminals/`.
- VPS-derived local TateSide env files are ignored by `.gitignore`:
  `.env.tateside-master.local` and `.env.tateside-staging.local`.
- VPS-derived local TateSide data lives under ignored `.tateside-data/`:
  `.tateside-data/vps-master` and `.tateside-data/vps-staging`.

## VPS Access

- VPS SSH alias: `easyschematic-vps`.
- Alias target: `debian@37.59.122.48`.
- SSH key on this PC:
  `C:\Users\seanl\.ssh\easyschematic_vps_ed25519`.
- Prefer the alias in commands:

```powershell
ssh easyschematic-vps
scp easyschematic-vps:/remote/path local/path
```

- The `debian` user currently has passwordless `sudo` on the VPS.
- Never ask Sean to paste the VPS password into chat. If password auth is ever
  needed again, open a local terminal/window for the prompt instead.

## Production vs Staging

Treat production and staging as separate deployments with separate branches,
services, API ports, data directories, and frontend routes.

Production:

- Repo path: `/home/debian/EasySchematic`.
- Branch: `master`.
- Local env file for smoke tests: `.env.tateside-master.local`.
- Local smoke-test API port: `127.0.0.1:18788`.
- Frontend route: `schematic.tateside.online`.
- Frontend container/upstream: `localhost:8080`.
- API service: `tateside-schematic-api.service`.
- API bind: `172.17.0.1:8788`.
- API route in Caddy: `/api/tateside/* -> 172.17.0.1:8788`.
- Data directory: `/var/lib/tateside-schematic`.
- DB path: `/var/lib/tateside-schematic/tateside.db`.

Staging:

- Repo path: `/home/debian/EasySchematic-staging`.
- Branch: `staging`.
- Local env file for smoke tests: `.env.tateside-staging.local`.
- Local smoke-test API port: `127.0.0.1:18789`.
- Frontend route: `testschematic.tateside.online`.
- Frontend container/upstream: `localhost:8081`.
- API service: `tateside-schematic-api-staging.service`.
- API bind: `172.17.0.1:8789`.
- API route in Caddy: `/api/tateside/* -> 172.17.0.1:8789`.
- Data directory: `/var/lib/tateside-schematic-staging`.
- DB path: `/var/lib/tateside-schematic-staging/tateside.db`.
- Staging currently disables SharePoint with `TATESIDE_DISABLE_SHAREPOINT=1`.

## VPS Safety Checks

- Fetching remote refs is safe; pulling/deploying changes live code and should
  only be done when Sean asks.
- Before changing Caddy, back up `/etc/caddy/Caddyfile`, validate with
  `sudo caddy validate --config /etc/caddy/Caddyfile`, then reload with
  `sudo systemctl reload caddy`.
- Caddy is expected to return the TateSide API's Cloudflare Access identity
  error for unauthenticated `/api/tateside/*` requests. That means the route is
  hitting the Node API rather than falling through to the frontend.
