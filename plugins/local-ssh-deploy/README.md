# Local SSH Deploy

`local-ssh-deploy` lets a local Codex agent remember deployment targets securely and publish the current project to a user-specified POSIX server through the machine's own OpenSSH tools. The server is only a deployment target; it is never configured as a remote Codex worker.

Named profiles are user-level and independent of any conversation or project. The deployment workflow packages the current directory (excluding `.git` and `.codex`), uploads the archive with `scp`, extracts it into the requested remote directory, and runs one exact saved command. A hashed dry run and explicit confirmation are required before any network or remote mutation occurs.

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

- PowerShell 7 (`pwsh`) and the local OpenSSH `ssh`, `scp`, and `tar` executables on `PATH`.
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

Ask Codex to save a deployment profile and provide:

- a profile name used only to look up these values;
- host and port;
- username;
- the private key's absolute local path (never the key text);
- a non-root absolute POSIX remote directory containing only letters, digits, `.`, `_`, `-`, and `/`;
- the exact single-line command to execute after extraction.

For example:

```text
Save a profile named production for example.com:22 as deploy, using
C:\Users\me\.ssh\deploy_ed25519, into /srv/www/example, then run exactly:
npm ci && npm run build && systemctl --user restart example
```

In a later task, ask “deploy this project using the saved production profile.” Codex lists or loads the profile from the OS credential store, runs `deploy.ps1 -ProfileName production -DryRun`, and shows the complete plan plus its hash. Confirm that rendered plan before Codex reruns it with `-ConfirmDeployment -PlanHash <approved-hash>`.

Manage profiles directly with `profiles.ps1 -List`, `-Show`, `-Save`, or `-Delete`. Overwriting and deleting existing profiles require explicit confirmation flags.

To keep the destination determined only by the displayed plan, the script ignores local SSH config files; the host must therefore be directly reachable with the supplied values. Extraction overlays the remote directory and does not delete stale remote files. If atomic releases or stale-file cleanup are required, encode that behavior in the exact deployment command and review it during the dry run.
