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

Pin a release instead of `main`: `LILYPAD_VERSION=v1.0.0` before the command (`$env:LILYPAD_VERSION='v1.0.0'` in PowerShell).

Running `./install.sh` (or `.\install.ps1`) from a clone installs the local files; nothing is downloaded.

### Non-interactive

`LILYPAD_URL=https://... LILYPAD_SKILL=no ./install.sh` skips every prompt. Change the URL later with `lilypad config url <URL>`. Update with `lilypad update`.

Requirements: bash CLI needs `curl` and `jq` (the installer offers to install jq). The PowerShell CLI needs nothing extra.

## First run

```bash
lilypad auth you@lftechnology.com   # emails you a 30-day key (company address only, no + aliases)
lilypad login lpk_...               # saves it (mode 600)
lilypad whoami
lilypad setup acme-poc --repo https://github.com/<org>/<repo> --port 3000 --health /health
lilypad create acme-poc
lilypad status acme-poc
```

Optional client: `lilypad setup shop --client acme --repo ...` serves the demo at `<name>-<client>` (`shop-acme`) and tags it `Client=acme`. The demo is still addressed by its name (`lilypad status shop`). The client can change until the first deploy and is fixed after that. `lilypad list --client acme` shows one client's demos. The client appears in the demo's URL, so use a code name where the client should not be named.

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
| `SIZE` | `--size` | Default `small`. |
| `ENV_FILE` | `--env-file` | A relative path is relative to the conf file. Leave it out to clear the demo's env vars. |

- A command-line option beats the same key in the file, and `<name>` beats `NAME`: `lilypad setup --conf demoproject.conf --size tiny`.
- The file is read as text, never run. An unknown or repeated key is an error that names the line, and nothing is sent.
- **The GitHub PAT is not a conf key** (it would end up in files and repos). Use `GITHUB_PAT` or the hidden prompt.
- `setup` still replaces the whole config on every run, so the file is the one place to edit and rerun.

`lilypad --how-to` prints a step-by-step guide to deploying a demo. `lilypad --help` lists everything; `lilypad <command> --help` explains one command. The GitHub PAT for `setup` is read from `$GITHUB_PAT` or a hidden prompt, never from an option.

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
