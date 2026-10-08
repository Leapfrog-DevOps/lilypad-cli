# Lilypad command reference

| Command | What it does | Who |
|---|---|---|
| `lilypad auth <email>` | Emails a new 30-day key. Replaces any earlier key. 1/min per email. | Anyone |
| `lilypad login <key>` | Saves key to `~/.config/lilypad/key` (mode 600). Local only. | Local |
| `lilypad logout` | Deletes saved key. Local only. | Local |
| `lilypad whoami` | Your email and key expiry. | Any valid key |
| `lilypad list [--client C]` | Active demos with client, owner and expiry; optionally one client's. | Any valid key |
| `lilypad setup <name> --repo <url> [opts]` | Saves demo config. No deploy. Rerun replaces whole config. | Anyone for new/destroyed name (fresh record, PAT required, creator too); creator after |
| `lilypad create <name>` (alias `deploy`) | Builds repo, creates stack. Async. | Creator |
| `lilypad redeploy <name>` | Rebuilds latest commit, rolls service, applies `setup` edits. Async. | Creator |
| `lilypad status <name>` | State, URL, owner, commit, size, expiry, task counts, settled flag. | Creator or admin |
| `lilypad logs <name> [lines]` | Container logs. Default 50, max 500. | Creator or admin |
| `lilypad extend <name>` | Expiry = now + 30 days; 90-day lifetime cap. Async. | Creator or admin |
| `lilypad destroy <name>` | Deletes stack and images. Irreversible. Async. | Creator or admin |
| `lilypad config url <URL>` | Saves the platform URL (https only). Local only. | Local |
| `lilypad update` | Reinstalls the latest CLI; key and URL kept. | Local |
| `lilypad '<json>'` / `lilypad -` | Raw JSON body from argument or stdin. | Per action |

Read just the text of a reply: `lilypad status <name> | jq -r .message`. Structured detail is under `.data`.

## setup options

| Option | Default | Notes |
|---|---|---|
| `--repo <url>` | required | `https://github.com/<org>/<repo>` |
| `--client <c>` | none | 1-20 chars `[a-z0-9-]`. Address becomes `<name>-<client>`, tag `Client`. Fixed once deployed; omit on rerun to keep. |
| `--branch <name>` | `main` | |
| `--port <n>` | `8080` | 1-65535 |
| `--health <path>` | `/` | Must return 200-399 with no login |
| `--size <s>` | `small` | tiny, small, medium, large (admin only) |
| `--env-file <file>` | none | `KEY=VALUE` per line, keys `[A-Z_][A-Z0-9_]*`. Omit to clear. |

PAT: `$GITHUB_PAT` or hidden prompt (TTY only). Never an option.

## Raw JSON API

POST to the platform URL, header `X-Lilypad-Key: <key>`, body `{"action": "...", "name": "...", "args": {...}}`.

```bash
lilypad '{"action":"logs","name":"acme-poc","args":{"lines":100}}'
jq -Rs '{action:"setup",name:"acme-poc",args:{repoUrl:"https://github.com/org/repo",githubPat:"...",env:.}}' demo.env | lilypad -
```

Setup `args` keys: `repoUrl`, `branch`, `port`, `healthPath`, `size`, `env` (file text), `githubPat`. Use stdin (`-`) whenever the body holds a secret.

## Environment variables

| Variable | Purpose |
|---|---|
| `LILYPAD_KEY` | Key instead of saved file (CI, sandboxes) |
| `LILYPAD_URL` | Platform URL (overrides the saved one) |
| `LILYPAD_EMAIL_DOMAIN` | Allowed email domain for `auth` |
| `LILYPAD_CONFIG_DIR` | PowerShell CLI: config directory (default `%APPDATA%\lilypad`) |
| `GITHUB_PAT` | PAT for `setup` |
| `XDG_CONFIG_HOME` | Moves key and URL files (default `~/.config`) |

## Lifecycle

setup, create, BUILDING (3-5 min), DEPLOYING (2-5 min), RUNNING, day 27 warning email, day 30 auto-destroy, DESTROYED. A destroyed name is free for anyone, the old creator included: `setup` replaces the old record and needs the PAT again, and `create` needs that new `setup` first. A name that never went live is released after 30 days without update.
