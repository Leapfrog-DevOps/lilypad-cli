# lilypad-cli

Command-line client for Lilypad, the self-serve demo platform: turn a GitHub repo (with a `Dockerfile`) into a live, disposable demo. Works on macOS, Linux and Windows.

## Install

You need the platform URL from your Lilypad admin. **The installer asks for it**; it is not stored in this repo.

macOS / Linux / WSL / Git Bash:

```bash
curl -fsSL https://raw.githubusercontent.com/Leapfrog-DevOps/lilypad-cli/main/install.sh | bash
```

Windows (PowerShell, no Git Bash or WSL needed):

```powershell
irm https://raw.githubusercontent.com/Leapfrog-DevOps/lilypad-cli/main/install.ps1 | iex
```

Pin a release instead of `main`: `LILYPAD_VERSION=v1.1.0` before the command (`$env:LILYPAD_VERSION='v1.1.0'` in PowerShell).

Running `./install.sh` (or `.\install.ps1`) from a clone installs the local files; nothing is downloaded.

### Non-interactive

`LILYPAD_URL=https://... LILYPAD_SKILL=no ./install.sh` skips every prompt. Change the URL later with `lilypad config url <URL>`. Update with `lilypad update`.

Requirements: bash CLI needs `curl` and `jq` (the installer offers to install jq). The PowerShell CLI needs nothing extra.

## First run

```bash
lilypad auth you@lftechnology.com   # emails you your 30-day key (company address only, no + aliases)
lilypad login lpk_...               # saves it (mode 600)
lilypad whoami
export GITHUB_AUTH=~/.ssh/lilypad_acme      # GitHub access: public, a deploy key file, or a PAT (below)
lilypad setup acme-poc --repo https://github.com/<org>/<repo> --port 3000 --health /health
lilypad create acme-poc
lilypad status acme-poc
```

Optional client: `lilypad setup shop --client acme --repo ...` serves the demo at `<name>-<client>` (`shop-acme`) and tags it `Client=acme`. The demo is still addressed by its name (`lilypad status shop`). The client can change until the first deploy and is fixed after that. `lilypad list --client acme` shows one client's demos. The client appears in the demo's URL, so use a code name where the client should not be named.

Optional notes: `lilypad setup shop --notes 'Acme pilot. Demo on 30 Oct\nLog in with the guest button' ...` keeps your own record with the demo (who it is for, dates, demo tips), up to 1000 characters; `\n` makes a line break. `status` shows them in full, `list` the first 40 characters. Unlike the other options, leaving `--notes` out keeps the stored notes; `--notes ""` clears them. Admins see them too, so no passwords.

### GitHub access

Lilypad needs read access to the repo. Give it one of three; it works out which:

| You give | For | How |
|---|---|---|
| `public` | a public repo | nothing to create |
| path to a private key file | a **deploy key** (one repo, read-only) | `ssh-keygen -t ed25519 -N "" -f ~/.ssh/lilypad_acme`, then add `lilypad_acme.pub` under the repo's **Settings > Deploy keys** with "Allow write access" off. Pass the private file (no `.pub`). No passphrase: the build cannot type one. ed25519 is recommended. |
| `github_pat_...` | a fine-grained **PAT** | read-only Contents access to that one repo |

`lilypad` never takes it as an option, so it stays out of shell history and `ps`:

- set `GITHUB_AUTH` in the environment (`GITHUB_PAT` still works), or
- type it at the hidden prompt (when run interactively).

A file path (a leading `~/` is expanded) is read by the CLI and the key's text is sent; a `.pub` file is refused. It is required on the first setup of a name, and whenever you set up a destroyed name, even your own. Blank on a rerun of a live demo keeps the stored one; a new value switches kind. A deploy key can't be checked through the GitHub API, so setup saves it without the repo check and the build's clone is the test: `Permission denied (publickey)` in `lilypad build-logs` means the `.pub` is not under that repo's Deploy keys (or it is a different key). "The repo is not public" means `public` was given for a private repo: use a deploy key or a PAT. `status` shows the kind as `githubAuth` (`pat`, `deploy-key` or `public`), never the value.

### Conf file

Instead of typing every option, keep them in a `.env`-style file and pass it with `--conf`:

```bash
lilypad setup --sample > demoproject.conf   # a documented template (same as [demoproject.sample.conf](demoproject.sample.conf))
# edit demoproject.conf, then:
lilypad setup --conf demoproject.conf
```

One `KEY=VALUE` per line; `#` starts a comment; values may be quoted. The keys are the `setup` options:

| Key | Option | Notes |
|---|---|---|
| `NAME` | `<name>` | Project name. Optional if you pass `<name>` on the command line. |
| `REPO` | `--repo` | Required (here or as `--repo`). |
| `CLIENT` | `--client` | Optional. |
| `BRANCH` | `--branch` | Default `main`. |
| `PORT` | `--port` | Default `8080`. |
| `HEALTH` | `--health` | Default `/`. |
| `SIZE` | `--size` | Default `tiny`. |
| `ENV_FILE` | `--env-file` | A relative path is relative to the conf file. Leave it out to clear the demo's env vars. |
| `NOTES` | `--notes` | Quote it; `\n` makes a line break. Leave it out to keep the stored notes; `NOTES=""` clears them. |

- A command-line option beats the same key in the file, and `<name>` beats `NAME`: `lilypad setup --conf demoproject.conf --size tiny`.
- The file is read as text, never run. An unknown or repeated key is an error that names the line, and nothing is sent.
- **GitHub access is not a conf key** (it would end up in files and repos). Use `GITHUB_AUTH` or the hidden prompt.
- `setup` still replaces the whole config on every run, so the file is the one place to edit and rerun.

`lilypad --how-to` prints a step-by-step guide to deploying a demo. `lilypad --help` lists everything; `lilypad <command> --help` explains one command. GitHub access for `setup` is read from `$GITHUB_AUTH` (alias `$GITHUB_PAT`) or a hidden prompt, never from an option.

## Web app

[`web/`](web/) is a browser version of the CLI: `index.html` plus `assets/` (CSS, JS, logo), no build step and no dependencies. Use the hosted copy (the demo named `lilypad`; ask your Lilypad admin for the address). The platform only accepts browser requests from that address, so a local copy works only against the mock server.

- **Onboarding**: connect to the platform (skipped when the site provides the URL), email yourself a key, paste it.
- **Demos**: cards with live status, build progress, expiry and actions (open, app logs, build log, deploy, redeploy, extend, edit, destroy). Search, client filter, auto-refresh (5 minutes by default; 10s to 10m, or off).
- **Demo panel**: overview with health and stage (a failed demo shows the failure cause; a deployment with no progress for 30 minutes is flagged as stuck, with Redeploy to free it), live-tail app logs, the latest build log (running or finished), settings, danger zone.
- **Admins** see every demo and can deploy, redeploy, extend or destroy any of them (with a confirm naming the owner, who gets a note). Editing settings stays with the creator.
- **New demo / Edit settings**: a five-step wizard (name, source, runtime, environment, review) that saves, waits for the repo check, then deploys. Env values are never returned by the platform, so re-enter them when editing. The Source step takes GitHub access the same three ways (type `public`, paste or load a deploy key file, or paste a PAT); it is sent once, never stored in the browser, and the review shows only its kind.
- **Help** (guide, FAQ, raw JSON requests like `lilypad -`) and **Settings** (account, platform URL, theme, auto-refresh).

The key and URL live in this browser's `localStorage`, so use it on your own machine only.

The repo's `Dockerfile` serves `web/` with nginx on port 8080, so Lilypad can host it as a demo of its own. Put the platform URL in an env file so users skip the connect step:

```bash
echo "LILYPAD_API_URL=<platform URL>" > web.env
GITHUB_AUTH=public lilypad setup lilypad --repo https://github.com/Leapfrog-DevOps/lilypad-cli --port 8080 --health /healthz --size tiny --env-file web.env
lilypad create lilypad
```

Try it locally: `python3 tests/mock_server.py /tmp/port /tmp/log &`, serve `web/` with `python3 -m http.server`, and enter `http://127.0.0.1:<port>/` as the platform URL.

## Files and variables

| Item | Mac/Linux | Windows |
|---|---|---|
| Binary | `~/.local/bin/lilypad` | `%LOCALAPPDATA%\lilypad\lilypad.cmd` + `lilypad.ps1` |
| Key | `~/.config/lilypad/key` | `%APPDATA%\lilypad\key` |
| URL | `~/.config/lilypad/url` | `%APPDATA%\lilypad\url` |

`LILYPAD_URL`, `LILYPAD_KEY`, `LILYPAD_EMAIL_DOMAIN` override the files. `XDG_CONFIG_HOME` moves the config on mac/linux.

## Claude skill

The installer can add a Claude skill (`skill/lilypad`) to `~/.claude/skills/lilypad`. It never contains the platform URL; it asks you for it.

## License

Proprietary. Copyright (c) 2026 Leapfrog Technology, Inc. All rights reserved. See [LICENSE](LICENSE). This repository is published so you can install and run the client, not to be copied, modified or redistributed.

## Development

```bash
tests/test_cli.sh      # bash CLI + installer against a local mock server
tools/leak-scan.sh     # fails on anything that looks internal (also runs in CI)
tools/gen-sums.sh      # refresh SHA256SUMS before tagging a release
```

The PowerShell CLI and installer have no automated test here yet (CI runs PSScriptAnalyzer; test on Windows by hand before each release).
