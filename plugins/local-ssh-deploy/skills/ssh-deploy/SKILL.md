---
name: ssh-deploy
description: Add and reuse secure SSH remote server connections for commands, inspection, maintenance, file workflows, and optional deployment. Use when the user says “添加一个远程服务器连接” or asks to add, save, configure, use, or replace an SSH server connection. Only route elsewhere when the user explicitly asks for a Codex remote worker or remote execution host. Never handle private key contents.
---

# SSH Remote Connections

Use the bundled `add_remote_server_connection` MCP tool to collect and save named SSH connection profiles through the plugin's interactive HTML editor. Use `list_profiles` to discover saved names. Profiles survive conversations, project deletion, and plugin updates and can be reused for remote inspection, service management, maintenance commands, file-oriented workflows, and project deployment.

## Safety boundary

- Treat the saved server as a general SSH target. Do not create, move, or hand off a Codex task to it and do not install or run Codex there unless the user separately and explicitly requests a Codex remote worker.
- Store only connection fields in a named profile: host, port, username, and `identityFilePath`. A profile name is only the lookup key. Remote directories, commands, passwords, tokens, private key contents, and task-specific values do not belong in the profile.
- `identityFilePath` must be an absolute path on the local machine. Never ask for, accept, display, copy, store, or read private key contents. If the user provides key text, stop and ask for an absolute path instead.
- Derive remote commands only from the user's concrete requested task. Show the exact resolved command and target in a dry run before execution; do not reuse a command from an earlier task as a profile default.
- Never bypass host-key verification. The bundled script requires the host to already be present in the local OpenSSH `known_hosts` file.
- Never fall back to plaintext profile storage. Windows uses per-user DPAPI plus restricted ACLs, macOS uses Keychain, and Linux uses Secret Service through `secret-tool`. If the platform secure store is unavailable or locked, stop and explain the prerequisite.

## Workflow

1. When the user refers to an existing server or asks what is remembered, call `list_profiles`. Do not search projects or conversation history for connection data.
2. Interpret an unqualified request such as “添加一个远程服务器连接” as this plugin's reusable SSH deployment connection. Route to Codex remote-host setup only when the user explicitly mentions a Codex remote worker or remote execution host. For a new or replacement connection, call `add_remote_server_connection` immediately. Pass a suggested profile name only when the user already supplied one. The tool serves the bundled editor on a randomized loopback-only URL and opens it in the system browser, so it works in Full Access without MCP elicitation or client-side MCP App rendering. It also advertises the same HTML as an MCP App resource for compatible clients. Do not ask the user to paste a field template into chat, and do not claim the browser opened before the tool completes successfully.
3. The editor places the profile name first and collects host, port, username, and the local private-key path. Its private-key field accepts manual absolute-path entry or calls `pick_identity_file` to open the operating system picker. The picker returns only the chosen path; never use ChatGPT file upload or a browser file input for a private key.
4. The `save_profile` MCP tool and storage script validate submitted values again before saving. Existing legacy profiles remain readable; any old deployment directory or command fields are ignored. Use `save_profile_with_form` only as a compatibility fallback for a client that cannot open the bundled editor and supports MCP elicitation.
5. Replacing an existing profile requires the user to select the editor's explicit overwrite control. Deleting one still requires explicit confirmation and `profiles.ps1 -Delete -ConfirmDelete`.
6. For a general server task, resolve the intended saved profile and the exact command. Run `remote.ps1 -ProfileName <name> -Command <command> [-WorkingDirectory <path>] -DryRun`, show the returned plan and `planHash`, and ask for confirmation of that exact plan.
7. Only after confirmation, rerun with `-ConfirmExecution -PlanHash <approved-hash>`. If any profile, directory, or command changes, generate and confirm a new plan. Report stdout, stderr, and exit status without silently retrying mutations or substituting another command.
8. For a requested upload or download, use `profiles.ps1 -Show -ProfileName <name>` to resolve connection arguments without reading the identity file, construct a bounded `scp` plan with exact local and remote paths, show it, and obtain confirmation before transfer. Keep strict host-key checking and ignore ambient SSH config as the bundled scripts do.
9. For project publishing, supply the deployment-specific directory and command at execution time: `deploy.ps1 -ProfileName <name> -RemoteDirectory <path> -DeploymentCommand <command> -DryRun`. After confirmation, use `-ConfirmDeployment -PlanHash <approved-hash>`. These values are never saved into the connection profile.

For ordinary profile creation, the user only needs to say something like:

```text
添加一个名为 production 的远程服务器连接
```

The tool must start the bundled editor and open its returned loopback URL in the system browser. If either step is unavailable, stop and report the exact failure; do not silently downgrade to terminal data entry. Use `scripts/profiles.ps1` directly only when the user explicitly requests a terminal workflow after being told the editor is unavailable.

```powershell
pwsh -NoLogo -NoProfile -File <plugin-root>/scripts/remote.ps1 `
  -ProfileName production -Command 'df -h' -DryRun
```

After the user confirms the displayed plan, replace `-DryRun` with `-ConfirmExecution -PlanHash <approved-hash>`.
