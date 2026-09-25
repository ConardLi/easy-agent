import { constants, type Stats } from "node:fs";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getPlansRoot } from "../utils/paths.js";
import {
  atomicWriteFile,
  atomicWriteFileFromHandle,
  ConcurrentFileModificationError,
  withFileLock,
} from "../utils/atomicFile.js";

let additionalAllowedRoots: string[] = [];

export class WorkspacePathError extends Error {
  readonly code = "EWORKSPACEBOUNDARY";

  constructor(message: string) {
    super(message);
    this.name = "WorkspacePathError";
  }
}

export class WorkspaceFileTooLargeError extends Error {
  readonly code = "EFBIG";

  constructor(
    readonly actualBytes: number,
    readonly maxBytes: number,
  ) {
    super(`File is too large to read (${actualBytes} bytes > ${maxBytes} byte limit)`);
    this.name = "WorkspaceFileTooLargeError";
  }
}

export interface WorkspacePathResolution {
  requestedPath: string;
  resolvedPath: string;
  declaredRoot: string;
  canonicalRoot: string;
  exists: boolean;
}

export type WorkspaceEntry =
  | {
      kind: "file";
      requestedPath: string;
      resolvedPath: string;
      stats: Stats;
      data: Buffer;
    }
  | {
      kind: "directory";
      requestedPath: string;
      resolvedPath: string;
      stats: Stats;
      entries: string[];
    };

export interface WorkspaceWriteResult {
  requestedPath: string;
  resolvedPath: string;
  existed: boolean;
}

export interface WorkspaceReadOptions {
  maxFileBytes?: number;
}

interface CanonicalizedPath {
  resolvedPath: string;
  exists: boolean;
}

interface WorkspacePathLease {
  resolution: WorkspacePathResolution;
  stats: Stats;
  handle?: FileHandle;
}

const NOFOLLOW_FLAG = constants.O_NOFOLLOW ?? 0;
const DIRECTORY_FLAG = process.platform === "win32" ? 0 : (constants.O_DIRECTORY ?? 0);

export function setAdditionalAllowedRoots(roots: string[]): void {
  additionalAllowedRoots = roots.map((root) => path.resolve(root));
}

export function getAdditionalAllowedRoots(): string[] {
  return additionalAllowedRoots;
}

export function getToolAllowedRoots(cwd: string): string[] {
  return [
    path.resolve(cwd),
    path.resolve(getPlansRoot()),
    ...additionalAllowedRoots,
  ];
}

export function describeAllowedRoots(cwd: string): string {
  return getToolAllowedRoots(cwd).join(", ");
}

export function expandHome(filePath: string): string {
  if (filePath === "~") return os.homedir();
  if (filePath.startsWith("~/") || filePath.startsWith("~\\")) {
    return path.join(os.homedir(), filePath.slice(2));
  }
  return filePath;
}

export function resolveSafePath(filePath: string, cwd: string): string {
  return path.resolve(cwd, expandHome(filePath));
}

function isContained(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function ensureInsideAllowedRoots(resolvedPath: string, cwd: string): void {
  const normalizedPath = path.resolve(resolvedPath);
  if (getToolAllowedRoots(cwd).some((root) => isContained(root, normalizedPath))) return;
  throw new WorkspacePathError(
    `Path is outside the allowed roots: ${resolvedPath}. Allowed roots: ${describeAllowedRoots(cwd)}`,
  );
}

function isErrno(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException)?.code === code;
}

async function canonicalizePath(
  target: string,
  allowMissing: boolean,
): Promise<CanonicalizedPath> {
  try {
    return { resolvedPath: await fs.realpath(target), exists: true };
  } catch (error) {
    if (isErrno(error, "ELOOP")) {
      throw new WorkspacePathError(`Symbolic-link loop is not allowed: ${target}`);
    }
    if (!allowMissing || !isErrno(error, "ENOENT")) throw error;
  }

  const missingSegments: string[] = [];
  let current = target;

  for (;;) {
    try {
      const currentStats = await fs.lstat(current);
      if (currentStats.isSymbolicLink()) {
        throw new WorkspacePathError(`Dangling symbolic link is not allowed: ${current}`);
      }
      const real = await fs.realpath(current);
      return {
        resolvedPath: path.join(real, ...missingSegments.reverse()),
        exists: false,
      };
    } catch (error) {
      if (error instanceof WorkspacePathError) throw error;
      if (isErrno(error, "ELOOP")) {
        throw new WorkspacePathError(`Symbolic-link loop is not allowed: ${target}`);
      }
      if (!isErrno(error, "ENOENT")) throw error;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      throw new WorkspacePathError(`Cannot resolve an existing ancestor for path: ${target}`);
    }
    missingSegments.push(path.basename(current));
    current = parent;
  }
}

async function resolveWorkspacePathDetails(
  filePath: string,
  cwd: string,
  allowMissing: boolean,
): Promise<WorkspacePathResolution> {
  const requestedPath = resolveSafePath(filePath, cwd);
  const matchingRoots = getToolAllowedRoots(cwd).filter((root) => isContained(root, requestedPath));
  if (matchingRoots.length === 0) {
    throw new WorkspacePathError(
      `Path is outside the allowed roots: ${requestedPath}. Allowed roots: ${describeAllowedRoots(cwd)}`,
    );
  }

  const candidate = await canonicalizePath(requestedPath, allowMissing);
  for (const declaredRoot of matchingRoots) {
    let root: CanonicalizedPath;
    try {
      root = await canonicalizePath(declaredRoot, true);
    } catch {
      continue;
    }
    if (isContained(root.resolvedPath, candidate.resolvedPath)) {
      return {
        requestedPath,
        resolvedPath: candidate.resolvedPath,
        declaredRoot,
        canonicalRoot: root.resolvedPath,
        exists: candidate.exists,
      };
    }
  }

  throw new WorkspacePathError(
    `Path resolves outside the allowed roots: ${requestedPath}. Allowed roots: ${describeAllowedRoots(cwd)}`,
  );
}

export async function resolveWorkspacePath(filePath: string, cwd: string): Promise<string> {
  return (await resolveWorkspacePathDetails(filePath, cwd, false)).resolvedPath;
}

export async function resolveWorkspacePathForWrite(
  filePath: string,
  cwd: string,
): Promise<WorkspacePathResolution> {
  return resolveWorkspacePathDetails(filePath, cwd, true);
}

function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function verifyLease(lease: WorkspacePathLease): Promise<void> {
  const currentRealPath = await fs.realpath(lease.resolution.resolvedPath);
  if (!isContained(lease.resolution.canonicalRoot, currentRealPath)) {
    throw new WorkspacePathError(
      `Path changed to a target outside the allowed root: ${lease.resolution.requestedPath}`,
    );
  }

  const currentStats = await fs.stat(currentRealPath);
  const expectedStats = lease.handle ? await lease.handle.stat() : lease.stats;
  if (!sameFile(expectedStats, currentStats)) {
    throw new WorkspacePathError(
      `Path changed while the operation was in progress: ${lease.resolution.requestedPath}`,
    );
  }
}

async function acquireReadLease(filePath: string, cwd: string): Promise<WorkspacePathLease> {
  const resolution = await resolveWorkspacePathDetails(filePath, cwd, false);
  const stats = await fs.stat(resolution.resolvedPath);
  const flags = constants.O_RDONLY | NOFOLLOW_FLAG | (stats.isDirectory() ? DIRECTORY_FLAG : 0);

  let handle: FileHandle | undefined;
  try {
    handle = await fs.open(resolution.resolvedPath, flags);
  } catch (error) {
    const canUseWindowsDirectoryFallback =
      process.platform === "win32" &&
      stats.isDirectory() &&
      (isErrno(error, "EISDIR") || isErrno(error, "EPERM"));
    if (!canUseWindowsDirectoryFallback) throw error;
  }

  const lease: WorkspacePathLease = { resolution, stats, ...(handle ? { handle } : {}) };
  try {
    await verifyLease(lease);
    return lease;
  } catch (error) {
    await handle?.close().catch(() => {});
    throw error;
  }
}

export async function withValidatedWorkspacePath<T>(
  filePath: string,
  cwd: string,
  operation: (resolvedPath: string, stats: Stats) => Promise<T>,
): Promise<T> {
  const lease = await acquireReadLease(filePath, cwd);
  try {
    const result = await operation(lease.resolution.resolvedPath, lease.stats);
    await verifyLease(lease);
    return result;
  } finally {
    await lease.handle?.close().catch(() => {});
  }
}

export async function withValidatedWorkspaceFile<T>(
  filePath: string,
  cwd: string,
  operation: (
    handle: FileHandle,
    resolution: WorkspacePathResolution,
    stats: Stats,
  ) => Promise<T>,
): Promise<T> {
  const lease = await acquireReadLease(filePath, cwd);
  try {
    if (!lease.stats.isFile() || !lease.handle) {
      throw new WorkspacePathError(`Only regular files can be read: ${filePath}`);
    }
    const result = await operation(lease.handle, lease.resolution, lease.stats);
    await verifyLease(lease);
    return result;
  } finally {
    await lease.handle?.close().catch(() => {});
  }
}

export async function readWorkspaceEntry(
  filePath: string,
  cwd: string,
  options: WorkspaceReadOptions = {},
): Promise<WorkspaceEntry> {
  const lease = await acquireReadLease(filePath, cwd);
  try {
    if (lease.stats.isDirectory()) {
      const entries = await fs.readdir(lease.resolution.resolvedPath);
      await verifyLease(lease);
      return {
        kind: "directory",
        requestedPath: lease.resolution.requestedPath,
        resolvedPath: lease.resolution.resolvedPath,
        stats: lease.stats,
        entries,
      };
    }
    if (!lease.stats.isFile()) {
      throw new WorkspacePathError(`Only regular files and directories can be read: ${filePath}`);
    }
    if (
      options.maxFileBytes !== undefined &&
      lease.stats.size > options.maxFileBytes
    ) {
      throw new WorkspaceFileTooLargeError(lease.stats.size, options.maxFileBytes);
    }
    if (!lease.handle) {
      throw new WorkspacePathError(`Could not acquire a stable file handle: ${filePath}`);
    }
    const data = await lease.handle.readFile();
    return {
      kind: "file",
      requestedPath: lease.resolution.requestedPath,
      resolvedPath: lease.resolution.resolvedPath,
      stats: lease.stats,
      data,
    };
  } finally {
    await lease.handle?.close().catch(() => {});
  }
}

export async function readWorkspaceFile(
  filePath: string,
  cwd: string,
  options: WorkspaceReadOptions = {},
): Promise<Extract<WorkspaceEntry, { kind: "file" }>> {
  const entry = await readWorkspaceEntry(filePath, cwd, options);
  if (entry.kind !== "file") {
    const error = new Error(`Path is a directory: ${entry.requestedPath}`) as NodeJS.ErrnoException;
    error.code = "EISDIR";
    throw error;
  }
  return entry;
}

async function ensureWorkspaceParent(filePath: string, cwd: string): Promise<void> {
  const requestedPath = resolveSafePath(filePath, cwd);
  const parent = path.dirname(requestedPath);
  const parentResolution = await resolveWorkspacePathDetails(parent, cwd, true);
  await fs.mkdir(parentResolution.resolvedPath, { recursive: true });
  await resolveWorkspacePathDetails(parent, cwd, false);
}

function contentDigest(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

async function prepareWorkspaceWrite(
  filePath: string,
  cwd: string,
): Promise<WorkspacePathResolution> {
  let resolution = await resolveWorkspacePathDetails(filePath, cwd, true);
  if (!resolution.exists) {
    await ensureWorkspaceParent(filePath, cwd);
    resolution = await resolveWorkspacePathDetails(filePath, cwd, true);
  }
  return resolution;
}

export async function writeWorkspaceFile(
  filePath: string,
  cwd: string,
  content: string | Buffer,
  options: { mode?: number } = {},
): Promise<WorkspaceWriteResult> {
  const initial = await prepareWorkspaceWrite(filePath, cwd);
  return withFileLock(initial.resolvedPath, async () => {
    const resolution = await prepareWorkspaceWrite(filePath, cwd);
    const existed = resolution.exists;
    const data = typeof content === "string" ? Buffer.from(content, "utf8") : content;
    await atomicWriteFile(resolution.resolvedPath, data, {
      ...(options.mode !== undefined ? { mode: options.mode } : {}),
    });
    await resolveWorkspacePathDetails(filePath, cwd, false);
    return {
      requestedPath: resolution.requestedPath,
      resolvedPath: resolution.resolvedPath,
      existed,
    };
  });
}

export async function writeWorkspaceFileFromHandle(
  filePath: string,
  cwd: string,
  sourceHandle: FileHandle,
  options: { mode?: number } = {},
): Promise<WorkspaceWriteResult> {
  const initial = await prepareWorkspaceWrite(filePath, cwd);
  return withFileLock(initial.resolvedPath, async () => {
    const resolution = await prepareWorkspaceWrite(filePath, cwd);
    const existed = resolution.exists;
    await atomicWriteFileFromHandle(resolution.resolvedPath, sourceHandle, {
      ...(options.mode !== undefined ? { mode: options.mode } : {}),
    });
    await resolveWorkspacePathDetails(filePath, cwd, false);
    return {
      requestedPath: resolution.requestedPath,
      resolvedPath: resolution.resolvedPath,
      existed,
    };
  });
}

export async function updateWorkspaceTextFile<T>(
  filePath: string,
  cwd: string,
  update: (
    original: string,
  ) => { content: string; value: T } | Promise<{ content: string; value: T }>,
): Promise<WorkspaceWriteResult & { value: T }> {
  const initial = await resolveWorkspacePathDetails(filePath, cwd, false);
  return withFileLock(initial.resolvedPath, async () => {
    const entry = await readWorkspaceFile(filePath, cwd);
    const originalDigest = contentDigest(entry.data);
    const next = await update(entry.data.toString("utf8"));
    await atomicWriteFile(entry.resolvedPath, Buffer.from(next.content, "utf8"), {
      beforeCommit: async () => {
        const current = await readWorkspaceFile(filePath, cwd);
        if (contentDigest(current.data) !== originalDigest) {
          throw new ConcurrentFileModificationError(entry.requestedPath);
        }
      },
    });
    await resolveWorkspacePathDetails(filePath, cwd, false);
    return {
      requestedPath: entry.requestedPath,
      resolvedPath: entry.resolvedPath,
      existed: true,
      value: next.value,
    };
  });
}

export async function removeWorkspaceFile(filePath: string, cwd: string): Promise<boolean> {
  const requestedPath = resolveSafePath(filePath, cwd);
  const parentPath = path.dirname(requestedPath);
  const parentLease = await acquireReadLease(parentPath, cwd);
  try {
    if (!parentLease.stats.isDirectory()) {
      throw new WorkspacePathError(`Parent path is not a directory: ${parentPath}`);
    }

    const deletionPath = path.join(
      parentLease.resolution.resolvedPath,
      path.basename(requestedPath),
    );
    let entryStats: Stats;
    try {
      entryStats = await fs.lstat(deletionPath);
    } catch (error) {
      if (isErrno(error, "ENOENT")) return false;
      throw error;
    }
    if (!entryStats.isFile() && !entryStats.isSymbolicLink()) {
      throw new WorkspacePathError(`Only regular files can be removed: ${filePath}`);
    }

    await verifyLease(parentLease);
    await fs.unlink(deletionPath);
    await verifyLease(parentLease);
    return true;
  } finally {
    await parentLease.handle?.close().catch(() => {});
  }
}
