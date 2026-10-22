# Lilypad troubleshooting

| Symptom | Meaning and fix |
|---|---|
| `HTTP 401` | No key, wrong, replaced or expired. `lilypad auth <email>`, then `lilypad login <key>`. |
| `HTTP 400` + `errors` | Input rejected. `errors` names the field: bad email (exact `@lftechnology.com`, no `+`), bad demo name, missing GitHub access, passphrase-protected or `.pub` deploy key, bad size/port. |
| `HTTP 403` | Name owned by someone else, or caller is not creator/admin, or `large` without admin. |
| `HTTP 409` | Demo busy (building, deploying, destroying). Wait until `Settled: yes`, retry. |
| `HTTP 429` | Key mailed to that address under a minute ago. Wait, retry. |
| `HTTP 502` on `auth` | The platform could not send the email. Previous key still works. Tell the Lilypad admins. |
| `auth` ok but no email | Check spam/junk as well as inbox (sender "Lilypad", subject "Your Lilypad access key"). Still missing: wait 1 minute, run `auth` again. |
| `lilypad: jq is required` | bash CLI only: install jq (the PowerShell CLI does not need it). |
| `no platform URL configured` | Run `lilypad config url <URL>` or re-run the installer. |
| CLI hangs or errors before any HTTP reply | Platform URL unset or wrong. Ask the user for it and have them run `lilypad config url <URL>`. |
| curl cannot resolve/connect | Sandbox without network. Run locally instead. |
| status: token cannot read repo | PAT lacks read Contents on that repo, or repo URL wrong. Rerun `setup` with every option. |
| status: repo is not public | Setup used `public` but GitHub can't see the repo anonymously. Rerun `setup` with a deploy key or PAT. |
| build-logs: `Permission denied (publickey)` | Deploy key's `.pub` not under that repo's Settings > Deploy keys, or a different key. Add it, or rerun `setup` with the right file, then `redeploy`/`create`. |
| setup: deploy key has a passphrase | The build cannot type a passphrase. Make a new key with `ssh-keygen -t ed25519 -N "" -f ~/.ssh/lilypad_<name>`, add its `.pub` as a deploy key, rerun `setup`. |
| setup: `... is not a private key` / that is the public key | `GITHUB_AUTH` points at the `.pub` file. Use the file without `.pub`. |
| status: Dockerfile missing | Repo root (branch built) needs a `Dockerfile`. Push it, rerun `setup`, then `create`. |
| Demo RUNNING but 5xx / unhealthy | Check `--port` matches container port and `--health` returns 200-399 without login. `lilypad logs <name> 200`. |
| Build failed (status FAILED, no image) | `lilypad build-logs <name> 200` shows the clone and docker build output; `logs` is empty because the app never started. Logs are kept 7 days. |
| Env vars vanished after edit | `setup` replaces whole config; rerun with `--env-file` again. |
| 6th demo refused | Cap is 5 active demos per person (25 for admins). Destroy one. |

Debug order for a failed deploy: `lilypad status <name> | jq -r .message`, then `jq .data`, then `lilypad build-logs <name> 200` if the build failed or `lilypad logs <name> 200` if the app did not come up, fix repo or config, `setup` (all options), `redeploy`.
