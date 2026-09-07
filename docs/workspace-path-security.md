# Workspace path security

Easy Agent file tools operate within the current working directory, trusted `additionalDirectories`, and the dedicated plan directory. Ordinary file tools do not receive access to the complete `~/.easy-agent` state tree. Memory, sessions, credentials, plugins, teams, and file-history backups remain behind their dedicated runtime features.

## Path validation

Every file-tool path passes two containment checks:

1. The lexical path must be inside a declared root. This rejects absolute and `..` traversal outside the configured boundary.
2. The canonical path must remain inside the canonical form of that same root. This resolves file links, directory links, junctions, and link chains before an operation begins.

Reads require the complete target to exist. Writes resolve the deepest existing ancestor, reject dangling links and link loops, and recheck the target after creating parent directories. A configured root may itself be a symbolic link; its canonical target becomes the allowed boundary.

## Stable operations

Regular-file reads and updates use an open file descriptor after canonical validation. On platforms that provide `O_NOFOLLOW`, the final path component cannot be replaced with a link during the open. The descriptor identity is compared with the current path before data is returned or changed.

Directory listings and subprocess searches retain a validation lease for the duration of the operation. Their results are discarded if the path resolves outside its allowed root or its filesystem identity changes before completion. Windows uses junction-aware canonical paths and identity checks when directory descriptors are unavailable.

Write, Edit, and MultiEdit write through the validated descriptor. File history applies the same boundary when creating backups, computing diffs, deleting files, and restoring snapshots. Paths restored from session data are validated again before they can affect the filesystem.

## Allowed internal paths

The plan directory is the only global Easy Agent directory exposed to ordinary file tools. This keeps Plan Mode compatible with its existing plan-file workflow without exposing user settings, session transcripts, memory, plugin data, or file-history backups.

Use dedicated commands and tools to manage other internal state. Add external working directories through the trusted `additionalDirectories` setting rather than linking out of the workspace.

Run `npm run test:path-boundary` after changing file tools, path resolution, allowed roots, or file-history restore behavior.
