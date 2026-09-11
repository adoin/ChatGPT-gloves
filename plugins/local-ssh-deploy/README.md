# Local SSH Deploy

`local-ssh-deploy` lets a local Codex agent publish the current project to a user-specified POSIX server through the machine's own OpenSSH tools. The server is only a deployment target; it is never configured as a remote Codex worker.

The workflow packages the current directory (excluding `.git` and `.codex`), uploads the archive with `scp`, extracts it into the requested remote directory, and runs one exact command supplied by the user. A dry run and an explicit confirmation are required before any network or remote mutation occurs.

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

- PowerShell 7 (`pwsh.exe`) and the local `ssh.exe`, `scp.exe`, and `tar.exe` executables on `PATH`.
- A key-based SSH login. Encrypted keys must already be available through the local SSH agent because batch mode disables password and passphrase prompts.
- The destination host already recorded in the local OpenSSH `known_hosts` file. Host-key checking is strict.
- A POSIX destination with `sh` and `tar`.
- The private key stored outside the project directory.

## Use

Ask Codex to deploy the current project and provide only:

- host and port;
- username;
- the private key's absolute local path (never the key text);
- a non-root absolute POSIX remote directory containing only letters, digits, `.`, `_`, `-`, and `/`;
- the exact single-line command to execute after extraction.

For example:

```text
Deploy this project to example.com:22 as deploy, using
C:\Users\me\.ssh\deploy_ed25519, into /srv/www/example, then run exactly:
npm ci && npm run build && systemctl --user restart example
```

Codex first runs the bundled script with `-DryRun` and shows the complete plan. Confirm that rendered plan before Codex reruns the same arguments with `-ConfirmDeployment`.

The plugin does not save deployment profiles or credentials. The script never reads private key bytes; it validates the absolute path and passes that path directly to the local OpenSSH executables.

To keep the destination determined only by the displayed plan, the script ignores local SSH config files; the host must therefore be directly reachable with the supplied values. Extraction overlays the remote directory and does not delete stale remote files. If atomic releases or stale-file cleanup are required, encode that behavior in the exact deployment command and review it during the dry run.
