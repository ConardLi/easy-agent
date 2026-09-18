# Local data security

Easy Agent stores user-specific state under `~/.easy-agent`. On macOS and Linux, the directory is created with mode `0700`; sensitive files are created with mode `0600`. The account running Easy Agent keeps normal read and write access while other local accounts cannot traverse the directory or read its files.

## Private data

The following data is treated as private:

- user settings and machine trust state;
- session transcripts and resume pointers;
- task graphs, plans, project memory, Agent Team metadata and mailboxes;
- file-history directories and background-agent output;
- plugin data and stream debug logs.

Existing installations are migrated on startup. Migration walks only known data directories, never follows symbolic links, and reports incomplete repairs through the startup warning and `/doctor`.

File-history backup files keep the source file's mode because `/rewind` uses that mode when restoring the workspace file. Their parent directories are private, so the contents remain inaccessible to other accounts without changing executable bits. Plugin cache contents also keep their original modes so plugin executables continue to work.

## Project and user-controlled output

`<project>/.easy-agent/settings.json` is a shareable project file and keeps normal repository permissions. `<project>/.easy-agent/settings.local.json` is personal and is created with mode `0600` without changing the containing project directory.

Files explicitly created by the user, including `/export` output and project `AGENT.md`, keep the permissions selected by the operating system and repository. Easy Agent does not silently make shared project files private.

## Stream debug logs

Stream logging is disabled unless `EASY_AGENT_DEBUG_STREAM=1` is set. When enabled, Easy Agent:

- writes `~/.easy-agent/stream-debug.log` with mode `0600`;
- redacts recognized credential fields and URL credentials, queries and fragments;
- rotates at 10 MiB and retains three previous files.

The log still contains model text, thinking blocks and tool payloads. Those values may contain source code or secrets embedded in ordinary text, so debug logs should be handled as sensitive data.

## Windows

Windows access control uses ACLs rather than POSIX `0600` and `0700` modes. Easy Agent stores data in the current user's profile so new files inherit that profile's ACL. `/doctor` reports this platform limitation instead of claiming that POSIX modes are enforced.

## Diagnostics

Run `/doctor` to inspect local data protection. A warning identifies the path and reason when ownership, a read-only filesystem or a symbolic link prevents migration. Correct the filesystem condition and restart Easy Agent to retry.
