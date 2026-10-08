# Lilypad troubleshooting

| Symptom | Meaning and fix |
|---|---|
| `HTTP 401` | No key, wrong, replaced or expired. `lilypad auth <email>`, then `lilypad login <key>`. |
| `HTTP 400` + `errors` | Input rejected. `errors` names the field: bad email (exact `@lftechnology.com`, no `+`), bad demo name, missing PAT, bad size/port. |
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
| status: Dockerfile missing | Repo root (branch built) needs a `Dockerfile`. Push it, rerun `setup`, then `create`. |
| Demo RUNNING but 5xx / unhealthy | Check `--port` matches container port and `--health` returns 200-399 without login. `lilypad logs <name> 200`. |
| Env vars vanished after edit | `setup` replaces whole config; rerun with `--env-file` again. |
| 4th demo refused | Cap is 3 active demos per person. Destroy one. |

Debug order for a failed deploy: `lilypad status <name> | jq -r .message`, then `jq .data`, then `lilypad logs <name> 200`, fix repo or config, `setup` (all options), `redeploy`.
