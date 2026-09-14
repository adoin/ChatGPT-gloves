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

The MCP server is implemented in Node.js and writes `connections.json` plus a generated OpenSSH `ssh_config` to a per-user application configuration directory:

- Windows: `%LOCALAPPDATA%\OpenAI\Codex\local-ssh-deploy\connections.json`
- macOS: `~/Library/Application Support/OpenAI/Codex/local-ssh-deploy/connections.json`
- Linux: `${XDG_CONFIG_HOME:-~/.config}/openai-codex/local-ssh-deploy/connections.json`

The directory and files are restricted to the current user. Windows ACLs allow only the current user and SYSTEM; macOS and Linux use directory mode `0700` and file mode `0600`. OpenSSH reads the real host, username, port, and identity-file path from `ssh_config`; Codex receives only a hashed alias and the config path.

These locations survive task closure, project deletion, and plugin updates. They are local to one OS user and are not synchronized between machines.

## Tools

- `add_remote_server_connection`: opens the bundled HTML connection editor;
- `save_connection`: validates and saves connection metadata;
- `list_connections`: returns saved connection names only;
- `get_connection`: returns only an opaque SSH alias, the restricted SSH config path, platform, and executable name;
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

Inventory questions use `list_connections` and return names only. Immediately before an actual server task, Codex calls `get_connection` and receives an opaque handle, then runs `ssh -F <sshConfigPath> <sshAlias>` or the equivalent native-tool form. The real host, username, port, and identity-file path stay in the restricted local files and are read directly by OpenSSH. Host-key verification must remain enabled. Read-only inspections can follow a clear request; remote mutations and file transfers require confirmation of the exact target and action.

The plugin cannot provide cryptographic isolation from a Codex task running with unrestricted filesystem access under the same OS account. Its normal tools and skill are designed to keep raw connection metadata out of model-visible tool results, chat replies, and command lines; Full Access can still technically read any same-user file if explicitly directed to do so.
