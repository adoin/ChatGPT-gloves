---
name: ssh-deploy
description: Save user-level SSH deployment profiles securely and publish the current local project or website through the local SSH client. Use for reusable, confirmation-gated SSH/SCP deployment across Codex tasks and projects, not for configuring a server as a remote Codex worker or handling private key contents.
---

# SSH Deploy

Use `scripts/profiles.ps1` to manage named user-level deployment profiles and `scripts/deploy.ps1` from the project directory the user wants to publish. Profiles survive conversations, project deletion, and plugin updates. The deployment script packages the current working directory, excluding `.git` and `.codex`, uploads it with the local `scp` executable, extracts it remotely, and then runs the profile's explicit deployment command.

## Safety boundary

- Treat the server only as a deployment target. Do not create, move, or hand off a Codex task to it and do not install or run Codex there.
- Store only these connection/deployment fields in a named profile: host, port, username, `identityFilePath`, remote directory, and the exact deployment command. A profile name is only the lookup key. Do not add passwords, tokens, private key contents, or arbitrary extra fields.
- `identityFilePath` must be an absolute path on the local machine. Never ask for, accept, display, copy, store, or read private key contents. If the user provides key text, stop and ask for an absolute path instead.
- Do not translate a vague intent such as "deploy normally" into a remote command. Require the exact command the user authorizes, such as `npm ci && npm run build && systemctl --user restart my-site`.
- Never bypass host-key verification. The bundled script requires the host to already be present in the local OpenSSH `known_hosts` file.
- Never fall back to plaintext profile storage. Windows uses per-user DPAPI plus restricted ACLs, macOS uses Keychain, and Linux uses Secret Service through `secret-tool`. If the platform secure store is unavailable or locked, stop and explain the prerequisite.

## Workflow

1. When the user refers to an existing server or asks what is remembered, run `profiles.ps1 -List`, then `-Show -ProfileName <name>` when the values are needed. Do not search projects or conversation history for connection data.
2. For a new connection, collect the six allowed fields and a profile name. The remote directory must be a non-root absolute POSIX path using only letters, digits, `.`, `_`, `-`, and `/`. Verify only the private key path and file metadata, never its bytes, then save with `profiles.ps1 -Save`.
3. Replacing an existing profile requires explicit confirmation and `-ConfirmOverwrite`. Deleting one requires explicit confirmation and `-ConfirmDelete`.
4. Establish that the current working directory is the intended project. Run `deploy.ps1 -ProfileName <name> -DryRun` and show the returned plan and `planHash`.
5. Ask for explicit confirmation of that exact plan. A general request to deploy before the dry run is not confirmation of the rendered plan. If any value, profile, or project directory changes, run a new dry run and confirm again.
6. Only after confirmation, rerun with `-ProfileName <name> -ConfirmDeployment -PlanHash <approved-hash>`. The script rejects a changed plan. Do not add confirmation based on inference or prior blanket permission.
7. Report the local packaging, upload, extraction, and remote-command result. On failure, stop; do not silently retry a mutation or substitute another command.

Use PowerShell 7 and pass each value as a separate parameter rather than constructing an interpolated shell command. Save a new profile with:

```powershell
pwsh -NoLogo -NoProfile -File <plugin-root>/scripts/profiles.ps1 `
  -Save -ProfileName production `
  -HostName example.com -Port 22 -Username deploy `
  -IdentityFilePath C:\Users\me\.ssh\deploy_ed25519 `
  -RemoteDirectory /srv/www/example `
  -DeploymentCommand "npm ci && npm run build"
```

On macOS or Linux, use that platform's absolute identity path. Then dry-run with:

```powershell
pwsh -NoLogo -NoProfile -File <plugin-root>/scripts/deploy.ps1 `
  -ProfileName production -DryRun
```

After the user confirms the displayed plan, replace `-DryRun` with `-ConfirmDeployment -PlanHash <approved-hash>`.
