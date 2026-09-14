# Local SSH Remote

`local-ssh-deploy` is a user-level SSH connection address book for Codex. It saves reusable connection metadata independently of conversations and projects. Codex retrieves a connection by name and then uses the current machine's native `ssh`, `scp`, `sftp`, or `rsync` tools to perform the requested work.

The plugin does not store or execute remote commands, deployment recipes, or project workflows. It is not a Codex remote-worker configuration tool.

## Install

Add the GitHub marketplace in ChatGPT Desktop:

```text
Source:      https://github.com/adoin/ChatGPT-gloves
Git ref:     main (or leave blank)
Sparse path: leave blank
```

Then install `local-ssh-deploy` and start a new Codex task. The user-facing skill is `$ssh-remote`.

## What a connection stores

Each named connection contains only:

- connection name;
- host;
- SSH port;
- SSH username;
- the private key's absolute local path.

Private key contents, passwords, commands, remote directories, and deployment settings are never stored. The private key itself remains in the user's SSH directory and is never read or uploaded by the plugin.

Connection names support Chinese and other Unicode letters, numbers, spaces, dots, underscores, and hyphens. Leading or trailing spaces and punctuation are rejected.

## Durable storage

The MCP server is implemented in Node.js and writes `connections.json` to a per-user application configuration directory:

- Windows: `%LOCALAPPDATA%\OpenAI\Codex\local-ssh-deploy\connections.json`
- macOS: `~/Library/Application Support/OpenAI/Codex/local-ssh-deploy/connections.json`
- Linux: `${XDG_CONFIG_HOME:-~/.config}/openai-codex/local-ssh-deploy/connections.json`

The directory and file are restricted to the current user. Windows ACLs allow only the current user and SYSTEM; macOS and Linux use directory mode `0700` and file mode `0600`. The file contains connection metadata, not authentication secret material.

These locations survive task closure, project deletion, and plugin updates. They are local to one OS user and are not synchronized between machines.

## Tools

- `add_remote_server_connection`: opens the bundled HTML connection editor;
- `save_connection`: validates and saves connection metadata;
- `list_connections`: returns saved connection names and the plugin-host platform;
- `get_connection`: returns one connection plus `platform`, `sshExecutable`, and `nullConfigPath` so Codex can use native tools;
- `delete_connection`: removes one explicitly confirmed connection;
- `pick_identity_file`: returns only a selected absolute path.

On Windows, the file picker uses the built-in Windows PowerShell/WinForms dialog. This tiny adapter is the only remaining PowerShell script; storage and remote work do not depend on PowerShell. macOS uses `osascript`, and Linux uses `zenity` or `kdialog` when available. Manual absolute-path entry is always available.

## Use

Add a connection:

```text
添加一个名为“生产服务器”的远程服务器连接
```

Use it later:

```text
用“生产服务器”查看磁盘空间
用“生产服务器”查看 nginx 最近的错误日志
把 build.zip 上传到“生产服务器”的 /srv/app
```

Codex calls `get_connection`, checks the returned platform, and builds the native command itself. Host-key verification must remain enabled. Read-only inspections can follow a clear request; remote mutations and file transfers require confirmation of the exact target and action.
