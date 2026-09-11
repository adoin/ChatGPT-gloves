---
name: ssh-deploy
description: Publish the current local project or website to a user-specified POSIX server through the local SSH client. Use for confirmation-gated SSH/SCP deployment, not for configuring a server as a remote Codex worker or handling private key contents.
---

# SSH Deploy

Use the bundled `scripts/deploy.ps1` from the project directory the user wants to publish. The script packages the current working directory, excluding `.git` and `.codex`, uploads it with the local `scp` executable, extracts it remotely, and then runs the user's explicit deployment command in the remote directory.

## Safety boundary

- Treat the server only as a deployment target. Do not create, move, or hand off a Codex task to it and do not install or run Codex there.
- Accept only these deployment values from the user: host, port, username, `identityFilePath`, remote directory, and the exact deployment command. Do not invent, infer, or persist credentials or deployment settings.
- `identityFilePath` must be an absolute path on the local machine. Never ask for, accept, display, copy, store, or read private key contents. If the user provides key text, stop and ask for an absolute path instead.
- Do not translate a vague intent such as "deploy normally" into a remote command. Require the exact command the user authorizes, such as `npm ci && npm run build && systemctl --user restart my-site`.
- Never bypass host-key verification. The bundled script requires the host to already be present in the local OpenSSH `known_hosts` file.

## Workflow

1. Establish that the current working directory is the intended project. Collect any missing allowed values. The remote directory must be a non-root absolute POSIX path using only letters, digits, `.`, `_`, `-`, and `/`.
2. Verify that the private key is identified only by a local absolute path. Do not inspect the file's bytes. The key must be outside the project directory so it cannot enter the upload archive.
3. Run `deploy.ps1` with `-DryRun`. Show the resulting plan to the user, including the local project root, destination, exclusions, remote directory, and exact deployment command.
4. Ask for explicit confirmation of that exact plan. A general request to deploy before the dry run is not confirmation of the rendered plan. If any value changes, run a new dry run and confirm again.
5. Only after confirmation, rerun the same arguments with `-ConfirmDeployment` instead of `-DryRun`. Do not add `-ConfirmDeployment` based on inference or prior blanket permission.
6. Report the local packaging, upload, extraction, and remote-command result. On failure, stop; do not silently retry a mutation or substitute another command.

Use PowerShell 7 and pass each value as a separate parameter rather than constructing an interpolated shell command:

```powershell
pwsh.exe -NoLogo -NoProfile -File <plugin-root>/scripts/deploy.ps1 `
  -HostName example.com -Port 22 -Username deploy `
  -IdentityFilePath C:\Users\me\.ssh\deploy_ed25519 `
  -RemoteDirectory /srv/www/example `
  -DeploymentCommand "npm ci && npm run build" `
  -DryRun
```

After the user confirms the displayed plan, replace `-DryRun` with `-ConfirmDeployment` and keep every other argument identical.
