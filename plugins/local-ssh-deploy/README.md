# Local SSH Deploy

`local-ssh-deploy` lets a local Codex agent remember deployment targets securely and publish the current project to a user-specified POSIX server through the machine's own OpenSSH tools. The server is only a deployment target; it is never configured as a remote Codex worker.

Named profiles are created through the plugin's HTML editor and remain independent of any conversation or project. The plugin serves the editor only on a randomized `127.0.0.1` URL and opens it in a dedicated browser window on Windows or the system browser on macOS and Linux; it also advertises the page as an MCP App resource for compatible clients. This works in Full Access without MCP elicitation or client-side component rendering. The deployment workflow packages the current directory (excluding `.git` and `.codex`), uploads the archive with `scp`, extracts it into the requested remote directory, and runs one exact saved command. A hashed dry run and explicit confirmation are required before any network or remote mutation occurs.

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
- A POSIX destination with `sh` and `tar`.
- The private key stored outside the project directory.
- On Linux, `secret-tool` plus an unlocked Secret Service provider such as GNOME Keyring or KWallet.

## Secure profile storage

Each named profile stores only host, port, username, the private key's absolute local path, remote directory, and exact deployment command. Private key bytes are never read or copied.

- Windows: DPAPI `CurrentUser` encrypted data at `%LOCALAPPDATA%\OpenAI\Codex\local-ssh-deploy\profiles.dat`, with inheritance removed and ACL access restricted to the current user and SYSTEM.
- macOS: a generic password item in the user's Keychain under service `openai.codex.local-ssh-deploy` and account `profiles-v1`, accessed directly through Security.framework so profile data is not placed in command-line arguments.
- Linux: an item in the user's Secret Service collection, written to `secret-tool` through standard input.

There is no plaintext fallback. These locations survive task closure, project deletion, and plugin updates. The SSH private key itself must remain at its saved absolute path.

## Use

Ask Codex:

```text
$ssh-deploy 新增一个名为 production 的部署连接
```

Codex calls the bundled `open_profile_editor` MCP tool, which starts a randomized loopback URL and opens it in the system browser. The interactive editor contains:

- profile name at the top;
- host and port;
- username;
- the private key's absolute local path, with manual entry and an operating-system file picker (never key text);
- the non-root POSIX remote directory;
- the exact single-line deployment command;
- an explicit checkbox for replacing an existing profile.

The editor calls `save_profile`, and the MCP server validates the submitted values before calling the same secure profile storage layer. The `pick_identity_file` tool returns only the selected absolute path: it does not read or upload the selected file. Terminal parameters remain available for diagnostics, but they are not the normal setup experience.

If the editor tool is unavailable, the skill reports the MCP startup problem and stops. It does not silently downgrade to terminal data entry. `save_profile_with_form` remains only as a compatibility fallback for hosts that cannot render MCP App resources and do support MCP elicitation.

In a later task, ask “deploy this project using the saved production profile.” Codex lists or loads the profile from the OS credential store, runs `deploy.ps1 -ProfileName production -DryRun`, and shows the complete plan plus its hash. Confirm that rendered plan before Codex reruns it with `-ConfirmDeployment -PlanHash <approved-hash>`.

Ask `$ssh-deploy 列出部署档案` to list profiles. Deleting a profile still requires explicit confirmation. Overwriting requires selecting the form's overwrite checkbox.

To keep the destination determined only by the displayed plan, the script ignores local SSH config files; the host must therefore be directly reachable with the supplied values. Extraction overlays the remote directory and does not delete stale remote files. If atomic releases or stale-file cleanup are required, encode that behavior in the exact deployment command and review it during the dry run.
