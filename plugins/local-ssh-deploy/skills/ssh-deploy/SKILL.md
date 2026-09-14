---
name: ssh-deploy
description: Save user-level SSH deployment profiles securely and publish the current local project or website through the local SSH client. Use for reusable, confirmation-gated SSH/SCP deployment across Codex tasks and projects, not for configuring a server as a remote Codex worker or handling private key contents.
---

# SSH Deploy

Use the bundled `open_profile_editor` MCP tool to collect and save named deployment profiles through the plugin's interactive HTML editor. Use `list_profiles` to discover saved names, and `scripts/deploy.ps1` from the project directory the user wants to publish. Profiles survive conversations, project deletion, and plugin updates. The deployment script packages the current working directory, excluding `.git` and `.codex`, uploads it with the local `scp` executable, extracts it remotely, and then runs the profile's explicit deployment command.

## Safety boundary

- Treat the server only as a deployment target. Do not create, move, or hand off a Codex task to it and do not install or run Codex there.
- Store only these connection/deployment fields in a named profile: host, port, username, `identityFilePath`, remote directory, and the exact deployment command. A profile name is only the lookup key. Do not add passwords, tokens, private key contents, or arbitrary extra fields.
- `identityFilePath` must be an absolute path on the local machine. Never ask for, accept, display, copy, store, or read private key contents. If the user provides key text, stop and ask for an absolute path instead.
- Do not translate a vague intent such as "deploy normally" into a remote command. Require the exact command the user authorizes, such as `npm ci && npm run build && systemctl --user restart my-site`.
- Never bypass host-key verification. The bundled script requires the host to already be present in the local OpenSSH `known_hosts` file.
- Never fall back to plaintext profile storage. Windows uses per-user DPAPI plus restricted ACLs, macOS uses Keychain, and Linux uses Secret Service through `secret-tool`. If the platform secure store is unavailable or locked, stop and explain the prerequisite.

## Workflow

1. When the user refers to an existing server or asks what is remembered, call `list_profiles`. Do not search projects or conversation history for connection data.
2. When the user asks to add, configure, save, or replace a connection, call `open_profile_editor` immediately. It renders through an MCP App resource and works in Full Access because it does not use MCP elicitation. Pass a suggested profile name only when the user already supplied one. Do not ask the user to paste a field template into chat.
3. The editor places the profile name first and collects the six allowed fields. Its private-key field accepts manual absolute-path entry or calls `pick_identity_file` to open the operating system picker. The picker returns only the chosen path; never use ChatGPT file upload or a browser file input for a private key.
4. The remote directory must be a non-root absolute POSIX path using only letters, digits, `.`, `_`, `-`, and `/`. The `save_profile` MCP tool and storage script validate submitted values again before saving. Use `save_profile_with_form` only as a compatibility fallback for a client that cannot render the bundled MCP App and supports MCP elicitation.
5. Replacing an existing profile requires the user to select the form's explicit overwrite control. Deleting one still requires explicit confirmation and `profiles.ps1 -Delete -ConfirmDelete`.
6. Establish that the current working directory is the intended project. Run `deploy.ps1 -ProfileName <name> -DryRun` and show the returned plan and `planHash`.
7. Ask for explicit confirmation of that exact plan. A general request to deploy before the dry run is not confirmation of the rendered plan. If any value, profile, or project directory changes, run a new dry run and confirm again.
8. Only after confirmation, rerun with `-ProfileName <name> -ConfirmDeployment -PlanHash <approved-hash>`. The script rejects a changed plan. Do not add confirmation based on inference or prior blanket permission.
9. Report the local packaging, upload, extraction, and remote-command result. On failure, stop; do not silently retry a mutation or substitute another command.

For ordinary profile creation, the user only needs to say something like:

```text
新增一个名为 production 的部署连接
```

The tool must open the bundled editor. If the editor tool is unavailable, stop and report that the bundled MCP server did not load; do not silently downgrade to terminal data entry. Use `scripts/profiles.ps1` directly only when the user explicitly requests a terminal workflow after being told the editor is unavailable. Deployment still uses PowerShell 7 with separate parameters:

```powershell
pwsh -NoLogo -NoProfile -File <plugin-root>/scripts/deploy.ps1 `
  -ProfileName production -DryRun
```

After the user confirms the displayed plan, replace `-DryRun` with `-ConfirmDeployment -PlanHash <approved-hash>`.
