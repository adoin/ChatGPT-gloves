---
name: ssh-remote
description: Add and reuse SSH remote server connections for commands, inspection, maintenance, transfers, and deployment. Use when the user says “添加一个远程服务器连接” or asks to add, save, configure, use, list, or remove an SSH server connection. Only route elsewhere when the user explicitly asks for a Codex remote worker or remote execution host. Never handle private key contents.
---

# SSH Remote Connections

This plugin is an SSH connection address book. It stores connection metadata and lets Codex retrieve it by name. Codex performs the requested server work itself with the current environment's native tools; the plugin does not prescribe or execute remote workflows.

## Connection boundary

- A connection contains only `connectionName`, host, port, username, and the absolute local `identityFilePath`.
- Never request, read, display, copy, upload, or store private key contents. If the user supplies key text, stop and request a local absolute path instead.
- Do not store commands, working directories, deployment paths, passwords, tokens, or task-specific values in a connection.
- Connections are local to the current OS user and survive task closure, project deletion, and plugin updates.
- A saved server is an SSH target, not a Codex remote worker. Only use remote-worker setup when the user explicitly requests that different capability.
- Treat raw host, username, port, and identity-file path as private connection metadata. Never repeat them in chat or request them through `get_connection` merely to answer an inventory question.

## Connection tools

1. For “添加一个远程服务器连接” or another add/replace request, call `add_remote_server_connection` immediately. Pass `suggestedConnectionName` only when the user already supplied a name. The tool opens the bundled editor. Do not ask the user to paste a field template into chat.
2. Use `list_connections` when the user asks what is remembered or does not identify which saved connection to use. This tool returns names only. Answer inventory and “what is saved?” questions from that list; do not call `get_connection` for each name and do not disclose raw connection fields.
3. Call `get_connection` only immediately before performing an actual user-requested task on one named server. It returns an opaque `sshAlias`, a permission-restricted `sshConfigPath`, the platform, and the SSH executable name. It never returns the host, username, port, or identity-file path.
4. Use `delete_connection` only after the user explicitly confirms the exact connection name; pass `confirmDelete: true` only then.

## Let Codex perform the task

- After `get_connection`, use the local shell and native `ssh`, `scp`, `sftp`, or `rsync` tools appropriate for the returned platform and the user's requested outcome.
- Address the server only as `ssh -F <sshConfigPath> <sshAlias>` or the equivalent `-F` form for the selected native tool. OpenSSH reads the real host, username, port, and identity-file path from the restricted config. Do not add `-i`, `-p`, `-l`, a raw hostname, or a username from any other source.
- Never read or print `connections.json` or the generated `ssh_config`; they are implementation details intended for the plugin and OpenSSH, not model context.
- Never disable host-key verification. If the host is not yet trusted, stop and ask the user to verify and add its fingerprint through a separate trusted process.
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
