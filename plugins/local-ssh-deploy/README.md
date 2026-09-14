# Local SSH Remote

`local-ssh-deploy` lets a local Codex agent remember reusable SSH server connections securely and use them for remote commands, inspection, maintenance, file workflows, and optional project deployment through the machine's own OpenSSH tools. A saved server is an SSH target, not a Codex remote worker.

Named profiles are created through the plugin's HTML editor and remain independent of any conversation or project. The plugin serves the editor only on a randomized `127.0.0.1` URL and opens it in a dedicated browser window on Windows or the system browser on macOS and Linux; it also advertises the page as an MCP App resource for compatible clients. This works in Full Access without MCP elicitation or client-side component rendering. Remote commands and project deployments use a hashed dry run and explicit confirmation before execution.

## Install

Add the repository marketplace in ChatGPT Desktop with:

```text
Source:      https://github.com/adoin/ChatGPT-gloves
Git ref:     main (or leave blank)
Sparse path: leave blank
```

Or use the Codex CLI:

```text
codex plugin marketplace add https://github.com/adoin/ChatGPT-gloves
codex plugin add local-ssh-deploy@chatgpt-gloves
```

Start a new Codex task after installation so the `ssh-deploy` skill is discovered.

## Prerequisites

- Node.js, PowerShell 7 (`pwsh`), and the local OpenSSH `ssh`, `scp`, and `tar` executables on `PATH`.
- A key-based SSH login. Encrypted keys must already be available through the local SSH agent because batch mode disables password and passphrase prompts.
- The destination host already recorded in the local OpenSSH `known_hosts` file. Host-key checking is strict.
- A POSIX destination with `sh`; project deployment also requires `tar`.
- For project deployment, the private key must be stored outside the project directory being packaged.
- On Linux, `secret-tool` plus an unlocked Secret Service provider such as GNOME Keyring or KWallet.

## Secure profile storage

Each named profile stores only host, port, username, and the private key's absolute local path. Commands, working directories, deployment paths, and other task-specific values are never stored in the connection profile. Private key bytes are never read or copied.

- Windows: DPAPI `CurrentUser` encrypted data at `%LOCALAPPDATA%\OpenAI\Codex\local-ssh-deploy\profiles.dat`, with inheritance removed and ACL access restricted to the current user and SYSTEM.
- macOS: a generic password item in the user's Keychain under service `openai.codex.local-ssh-deploy` and account `profiles-v1`, accessed directly through Security.framework so profile data is not placed in command-line arguments.
- Linux: an item in the user's Secret Service collection, written to `secret-tool` through standard input.

There is no plaintext fallback. These locations survive task closure, project deletion, and plugin updates. The SSH private key itself must remain at its saved absolute path.

## Use

Ask Codex:

```text
$ssh-deploy 添加一个名为 production 的远程服务器连接
```

Codex calls the bundled `add_remote_server_connection` MCP tool, which starts a randomized loopback URL and opens it in the system browser. The interactive editor contains:

- connection name at the top;
- host and port;
- username;
- the private key's absolute local path, with manual entry and an operating-system file picker (never key text);
- an explicit checkbox for replacing an existing profile.

The editor calls `save_profile`, and the MCP server validates the submitted values before calling the same secure profile storage layer. The `pick_identity_file` tool returns only the selected absolute path: it does not read or upload the selected file. Terminal parameters remain available for diagnostics, but they are not the normal setup experience.

If the editor tool is unavailable, the skill reports the MCP startup problem and stops. It does not silently downgrade to terminal data entry. `save_profile_with_form` remains only as a compatibility fallback for hosts that cannot render MCP App resources and do support MCP elicitation.

In a later task, ask “use production to check disk usage” or “restart the service on production.” Codex resolves the connection from the OS credential store, runs `remote.ps1 -ProfileName production -Command <exact-command> -DryRun`, and shows the target, command, optional working directory, and plan hash. After confirmation it reruns with `-ConfirmExecution -PlanHash <approved-hash>`.

Project deployment remains available, but deployment-specific values are supplied for that task rather than stored in the connection. Codex runs `deploy.ps1 -ProfileName production -RemoteDirectory <path> -DeploymentCommand <command> -DryRun`, then uses the confirmed plan hash for execution.

Ask `$ssh-deploy 列出远程连接` to list profiles. Deleting a profile still requires explicit confirmation. Overwriting requires selecting the editor's overwrite checkbox.

To keep each target determined only by the displayed plan, the scripts ignore local SSH config files; the host must therefore be directly reachable with the supplied values. Host-key checking remains strict. Deployment extraction overlays the chosen remote directory and does not delete stale files unless the task's confirmed command explicitly does so.
