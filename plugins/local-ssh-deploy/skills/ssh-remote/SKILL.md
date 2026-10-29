---
name: ssh-remote
description: Add and reuse SSH remote server connections for commands, inspection, maintenance, transfers, and deployment. Use when the user says “添加一个远程服务器连接” or asks to add, save, configure, use, list, or remove an SSH server connection. Only route elsewhere when the user explicitly asks for a Codex remote worker or remote execution host. Never handle private key contents.
---

# SSH Remote Connections

This plugin is an SSH connection address book. It stores connection metadata and lets Codex retrieve it by name. Codex performs the requested server work itself with the current environment's native tools; the plugin does not prescribe or execute remote workflows.

## Connection boundary

- Connections contain a name, host, port, username and either an absolute local private-key path or an opaque password credential reference. Existing key connections need no migration.
- Never request, read, display, copy, upload, or store private key contents. If the user supplies key text, stop and request a local absolute path instead.
- Passwords are entered only in the system-browser editor and saved in the OS credential store. Never request a password in chat, send it through MCP tools, read it into model context, or put it in arguments/environment variables. Do not store plaintext passwords, commands, directories, tokens, or task-specific values in connection metadata.
- Connections are local to the current OS user and survive task closure, project deletion, and plugin updates.
- A saved server is an SSH target, not a Codex remote worker. Only use remote-worker setup when the user explicitly requests that different capability.
- Treat raw host, username, port, and identity-file path as private connection metadata. Never repeat them in chat or request them through `get_connection` merely to answer an inventory question.

## Connection tools

1. For “添加一个远程服务器连接” or another add/replace request, call `add_remote_server_connection` immediately. Pass `suggestedConnectionName` only when the user already supplied a name. The tool opens the bundled editor. Do not ask the user to paste a field template into chat.
2. Use `list_connections` when the user asks what is remembered or does not identify which saved connection to use. This tool returns names only. Answer inventory and “what is saved?” questions from that list; do not call `get_connection` for each name and do not disclose raw connection fields.
3. Call `get_connection` only immediately before performing an actual user-requested task on one named server. It returns an opaque `sshAlias`, a permission-restricted `sshConfigPath`, the platform, and the SSH executable name. It never returns the host, username, port, or identity-file path.
4. On Windows, when either authentication mode reports missing host trust or host-key verification failure, immediately call `open_connection_terminal` for that saved connection. It opens a visible PowerShell 7 window and leaves it open. Tell the user to review the fingerprint and type yes/no there; do not make them reconstruct SSH commands or submit a password in chat. Only the user may choose yes. Changed/revoked keys remain blocked and require explicit review; never remove old keys automatically. The terminal checks the connection only and never replays a task command. Wait for the user to finish, then resume within the original authorization; never silently retry a mutation.
5. Use `delete_connection` only after the user explicitly confirms the exact connection name; pass `confirmDelete: true` only then.

## Password connections

- Install the plugin’s locked dependencies with `npm ci --ignore-scripts --no-audit --no-fund` from the plugin root when needed. Passwords use Windows Credential Manager, macOS Keychain or Linux Secret Service. Missing/locked credentials fail closed; never fall back to plaintext storage.
- `get_connection` adds `passwordClientPath` for password connections. Use `node <passwordClientPath> <sshAlias> exec "COMMAND"` for commands, `upload LOCAL REMOTE` or `download REMOTE LOCAL` for a single file. The helper retrieves credentials internally and performs no automatic command retries. It supports password authentication, not MFA or arbitrary keyboard-interactive challenges.
- Do not use native `ssh/scp/rsync` for automatic saved-password login. The helper verifies the server key against the current user’s OpenSSH `known_hosts`/`known_hosts2` and the standard system known-hosts file. Noninteractive unknown, changed, revoked, or certificate-only trust is refused. On Windows use `open_connection_terminal` for user confirmation; it can add a previously unknown exact key only after an explicit yes, then authenticate using the saved password. Changes or revocations are not ordinary first-use confirmations. On other platforms use a separately verified trust process. It does not inherit arbitrary OpenSSH configuration such as ProxyJump; do not silently bypass those requirements.
- `save_connection` through MCP accepts key connection metadata only. Password submissions must go through the loopback browser editor, never an embedded MCP form.

## Let Codex perform the task

- For key connections, after `get_connection`, use the local shell and native `ssh`, `scp`, `sftp`, or `rsync` tools appropriate for the returned platform and the user's requested outcome.
- Address the server only as `ssh -F <sshConfigPath> <sshAlias>` or the equivalent `-F` form for the selected native tool. OpenSSH reads the real host, username, port, and identity-file path from the restricted config. Do not add `-i`, `-p`, `-l`, a raw hostname, or a username from any other source.
- Never read or print `connections.json` or the generated `ssh_config`; they are implementation details intended for the plugin and OpenSSH, not model context.
- Never disable host-key verification or automatically answer yes. Use the connection terminal workflow above for unknown host trust on Windows. Native key connections use the saved config and let OpenSSH handle the confirmation; password connections display the exact received key fingerprint and retrieve/send the saved password only after confirmation.
- A clear request for a read-only inspection, such as checking disk usage or reading logs, authorizes that inspection. Show the target and obtain explicit confirmation immediately before commands that mutate remote state, transfer files, change services, install software, or delete data.
- Do not silently retry a mutation, broaden a path, substitute a different command, or infer authorization for adjacent work. Report command output and failures accurately.

Ordinary setup requires only:

```text
添加一个名为“生产服务器”的远程服务器连接
```

Later tasks can be phrased naturally:

```text
用“生产服务器”查看磁盘空间
用“生产服务器”查看 nginx 最近的错误日志
把这个构建产物上传到“生产服务器”的 /srv/app
```
