# Persistence and consistency

Easy Agent keeps durable state in ordinary files so it remains inspectable and portable. Persistence code uses a shared write path with the following commit sequence:

1. create a uniquely named temporary file in the destination directory;
2. write the complete new content and flush the file;
3. rename the temporary file over the destination;
4. flush the parent directory so the rename survives a system restart.

The destination is never truncated in place. A process failure before the rename leaves the previous version readable. A failure after the rename leaves the complete new version readable. On Windows, Node.js and the filesystem may not support flushing a directory handle; Easy Agent still flushes the file and performs the atomic replacement.

Private state continues to use `0600` files inside `0700` directories on macOS and Linux. Existing modes are preserved when a workspace file is replaced. Symbolic links are rejected at the commit path.

## Consistency by data type

| Data | Consistency model |
| --- | --- |
| User, project and local settings | The complete read, shallow merge and write operation runs under a cross-process file lock. Concurrent updates to different keys are retained. |
| Runtime state and workspace trust | Writers take a cross-process lock and reload the current file before applying a change. The in-process cache is updated only after the durable write succeeds. |
| Tasks | Task creation, dependency changes, deletion and reset use a list lock. Each task update also uses its own file lock, which allows independent tasks to progress concurrently. Dependency creation writes the scheduling constraint before its reverse index so an interrupted update does not make a blocked task runnable. |
| Agent Team metadata | Member mutations take a cross-process lock, reload the latest team document and replace it atomically. |
| Agent Team mailboxes | Writers serialize the read-append-write sequence per inbox. Readers see the complete document from before or after a write. |
| Sessions | Each JSONL record is appended under a cross-process lock and flushed before the operation returns. The `latest` pointer is replaced atomically. Concurrent processes cannot interleave records. |
| Plugin registry state | Startup reads remain fail-soft and `/doctor` reports invalid files. Mutations run under the plugin state lock, reload the latest document and refuse to overwrite malformed or unsupported state. |
| Workspace Write | The complete file is replaced atomically after path-boundary validation. |
| Workspace Edit and MultiEdit | The tool locks the target, records a SHA-256 digest, prepares the edit and verifies the digest again immediately before replacement. A changed target causes the edit to fail and asks the caller to read and retry. |

Locks coordinate Easy Agent processes. Programs that edit the same files without using these locks are detected by the digest check for Edit and MultiEdit, but they do not participate in settings or state locking.

Task dependency and deletion operations may touch more than one task file. The list lock prevents concurrent Easy Agent graph operations from interleaving, and every individual file remains atomic. The filesystem is not treated as a transactional database, so a machine failure between two task-file commits can leave a stale reverse reference. Scheduling uses `blockedBy` as its authoritative constraint, and dependency creation commits that side first.

## Invalid persisted data

Malformed JSON and invalid task records are not silently replaced. The operation reports the file path and leaves the original bytes untouched so they can be inspected or recovered. Runtime trust state fails closed: the project is treated as untrusted, `/doctor` reports the state error, and no state update is allowed to overwrite the damaged file.

To recover, move the reported file aside, repair its contents, or restore it from a backup. Restart Easy Agent after repairing runtime state so the in-process diagnostic and cache are refreshed.

## Verification

Run the focused persistence suite after changing storage, file tools, tasks, teams or sessions:

```bash
npm run test:persistence
```

The suite covers process termination before rename, injected commit failures, concurrent multi-process updates, corrupt data preservation, legacy runtime state, session append serialization and Edit conflict detection. The same suite is part of `npm run verify:production`.
