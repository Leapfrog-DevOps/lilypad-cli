---
name: lilypad
description: Deploy and manage disposable demos on the Lilypad self-serve demo platform with the installed `lilypad` CLI. Use when the user wants to turn a GitHub repo into a live demo, or to authenticate, set up, create, redeploy, check status, read logs, extend, list or destroy a Lilypad demo, or mentions Lilypad, an `lpk_` key, or `lilypad` commands.
---

# Lilypad

Lilypad builds a GitHub repo (needs a `Dockerfile`) and serves it at a public URL under the platform's demo domain (`{name}.<domain>`, or `{name}-{client}.<domain>` when a client is given). Demos auto-delete after 30 days. This skill drives the platform through the `lilypad` command on PATH (install: see the lilypad-cli README). On Windows it is `lilypad.cmd` (PowerShell CLI).

## Before any command

1. `lilypad` must be on PATH: check `command -v lilypad` (Windows: `Get-Command lilypad`). If missing, tell the user to install it from the lilypad-cli README. Do not install it yourself from an unverified source.
2. **URL**: the CLI reads the platform URL from `LILYPAD_URL` or the file saved by the installer (`lilypad config url <URL>`).
   - If a command says "no platform URL configured", **ask the user** for the URL (see "Asking the user for input"), then have them run `lilypad config url <URL>` themselves, or `export LILYPAD_URL=...` for the session.
   - Never guess or invent a URL, and never search the machine or the internet for one.
3. **Key**: `LILYPAD_KEY` env var, else `~/.config/lilypad/key`. Missing or HTTP 401: do the auth flow below.
4. In a restricted sandbox, if `curl` to the URL fails (network blocked), stop and tell the user to run the commands locally. Do not invent results.

## Asking the user for input

Never guess a missing value. For every input the user must supply, ask one question that offers a **default option first** (marked "(Recommended)" when a default exists) plus manual input. In Claude Code use AskUserQuestion (user types manual values under "Other"; batch up to 4 questions per call). In Claude.ai ask in chat: state the default and say "or type your own". Skip a question when the user already gave the value.

| Input | Default option | Manual input |
|---|---|---|
| Platform URL | value already configured, if any | paste URL |
| Email for `auth` | email from context if known | type `@lftechnology.com` address |
| Key (`lpk_...`) | "I already ran `lilypad login`" | paste key (or run `login` themselves) |
| Demo name (project) | repo name, lowercased, invalid chars to `-`, if it passes the name rule | type name |
| Client | none | type client slug (e.g. `acme`) |
| Repo URL | git remote `origin` of the current repo, if GitHub | type `https://github.com/<org>/<repo>` |
| Branch | `main` | type branch |
| Port | `8080` | type 1-65535 |
| Health path | `/` | type path |
| Size | `small` | tiny / medium / large (admin only) |
| Env file | none | type file path |
| Log lines | `50` | type 1-500 |
| GitHub PAT | "`GITHUB_PAT` was exported before launch (Recommended)" | "PAT is on my clipboard" (run via `pbpaste`); "I will run setup myself". Only these three options are listed. Question text adds: "Or type the PAT under Other (not recommended: it stays in the transcript)". Typing under Other is the manual input. |
| Confirm destroy / redeploy | "Cancel" | "Yes, proceed" |

Ask for the destructive confirmation with the safe option as the default. Ask once per workflow, not once per command.

## Auth flow (identity is a verified email)

```bash
lilypad auth you@lftechnology.com   # emails a 30-day key; exact @lftechnology.com, no "+" aliases
lilypad login lpk_...               # saves key, mode 600
lilypad whoami
```

- After `auth` succeeds, tell the user: the key arrives within a minute from "Lilypad", subject "Your Lilypad access key". **Check the spam/junk folder too** if it is not in the inbox. If still missing after a few minutes, wait out the 1-minute limit and run `auth` again (the newest key replaces the older one).
- The user must read the key from the email and give it to you (or run `login` themselves). Never invent or guess one.
- Never print, echo, log or repeat the key or any PAT back. Pass keys through env or the saved file, never as part of a visible message.
- `auth` replaces any earlier key at once. 1 request per email per minute.
- The CLI rejects any address that is not a plain `@lftechnology.com` one (other domains, `+` aliases, subdomains) before contacting the platform. Check the address yourself first and ask the user for their company email instead of trying a personal one.

## Deploy workflow

1. `lilypad setup <name> --repo https://github.com/<org>/<repo> [--client C] [--branch B] [--port N] [--health /path] [--size tiny|small|medium|large] [--env-file FILE]`
   - **Conf file**: with several options, offer to write them to a `demoproject.conf` (`.env` style: `NAME REPO CLIENT BRANCH PORT HEALTH SIZE ENV_FILE`; `lilypad setup --sample` prints a template) and run `lilypad setup --conf demoproject.conf`. Command-line options override the file. **Never put the PAT or any secret in it**: it is not a conf key and the CLI rejects it.
   - Saves config only. Rerunning **replaces the whole config**: repeat every option to keep it. Omitting `--env-file` clears env vars. Omitting `--client` keeps the stored client; the client is fixed once deployed (destroy and set up again to change it).
   - **GitHub PAT**: fine-grained, read-only Contents on that one repo. Read from `$GITHUB_PAT` or a hidden prompt, never an option. Needed on first setup and on any setup of a destroyed name, even your own. Blank on rerun of a live demo keeps the stored one.
   - A prompt cannot run in an agent shell, and env set in one Bash call does not persist to the next. Do not ask the user to paste a PAT into chat, and never put a literal PAT in a command (it lands in the transcript). Ways to supply it:
     1. User exports `GITHUB_PAT` in their terminal, then launches Claude Code from that shell. Check with `[ -n "${GITHUB_PAT:-}" ] && echo set`, never print it.
     2. User copies the PAT to the clipboard and runs `! GITHUB_PAT=$(pbpaste) lilypad setup <name> --repo ...` (macOS; `xclip -o` / `wl-paste` on Linux).
     3. **Paste in chat (not recommended).** Not a listed option: it is the manual input (Other) of the PAT question, and the question text says it is not recommended because the PAT stays in the transcript. If the user types a PAT there (or in chat), send it only through a stdin heredoc, never as an argument or env prefix (visible in `ps`):
        ```bash
        lilypad - <<'EOF'
        {"action":"setup","name":"<name>","args":{"repoUrl":"<url>","githubPat":"<pat>"}}
        EOF
        ```
        Add the other `setup` args (client, branch, port, healthPath, size) to the same JSON; for env vars, merge file text with `jq -c --rawfile env FILE '.args.env=$env' <<'EOF' | lilypad -`. Never repeat the PAT in later messages or files. Afterwards tell the user to revoke the token if the transcript is shared.
     4. Claude.ai has no user shell, so typing the PAT in chat is the only way there: say it is not recommended first, and suggest running `setup` locally instead.
2. `lilypad status <name> | jq -r .data.lastMessage` should say "Repo readable, Dockerfile found". If token or Dockerfile error, fix and rerun `setup`.
3. `lilypad create <name>` (alias `deploy`). Async. Then poll `lilypad status <name> | jq -r .message` about once a minute. BUILDING 3-5 min, DEPLOYING 2-5 min, then RUNNING with `Settled: yes`. Give the user the URL.
4. Changes: edit the conf file (or repeat all `setup` options) and rerun `setup`, then `lilypad redeploy <name>`.
5. Other: `lilypad logs <name> [lines]` (default 50, max 500), `lilypad extend <name>` (now + 30 days, 90-day lifetime cap), `lilypad list [--client C]`, `lilypad destroy <name>`.

Name rule: `^[a-z][a-z0-9-]{1,22}[a-z0-9]$` (3-24 chars). Reserved: www, api, admin, app, mail, status, help, test, core, dns.
Client rule (optional): `^[a-z0-9]([a-z0-9-]{0,18}[a-z0-9])?$` (1-20 chars). Commands still take the name, not `name-client`.
Sizes (CPU units / MiB): tiny 256/512, small 512/1024 (default), medium 1024/2048, large 2048/4096 (admin only).
Defaults: branch `main`, port `8080`, health `/` (must return 200-399 without login; add open `/health` if app is behind auth).

## Rules for the agent

- **Confirm before `destroy`** (irreversible), before `redeploy` on someone's live demo, and before `create`/`redeploy` of a name the user has not named explicitly.
- `create`, `redeploy`, `extend`, `destroy` are async: reply "accepted" only. Verify with `status`. Do not claim success until `status` shows RUNNING / DESTROYED and `Settled: yes`.
- Only the creator may `setup` (existing), `create`, `redeploy`. Creator or admin may `status`, `logs`, `extend`, `destroy`. Max 3 active demos per person.
- Env vars via `--env-file` are visible to the platform operators: no real secrets. 
- Platform adds no auth to demos. App's own job.
- Email arrives once per create/redeploy outcome and a reminder 3 days before expiry.
- On errors, map via [references/troubleshooting.md](references/troubleshooting.md).

## Reference

- [references/commands.md](references/commands.md): every command, options, raw JSON API, env vars.
- [references/troubleshooting.md](references/troubleshooting.md): HTTP codes and common failures.
- Per-command help: `lilypad <command> --help`.
