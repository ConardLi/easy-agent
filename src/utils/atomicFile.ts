import { randomBytes } from "node:crypto";
import { constants, closeSync, fchmodSync, fsyncSync, lstatSync, mkdirSync, openSync, renameSync, unlinkSync, writeSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import lockfile from "proper-lockfile";

const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;
const DIRECTORY_FLAG = process.platform === "win32" ? 0 : (constants.O_DIRECTORY ?? 0);

export const FILE_LOCK_OPTIONS = {
  realpath: false,
  retries: {
    retries: 30,
    minTimeout: 5,
    maxTimeout: 100,
  },
  stale: 30_000,
  update: 10_000,
} as const;

export class PersistentDataError extends Error {
  readonly code = "EDATACORRUPT";

  constructor(
    readonly filePath: string,
    message: string,
  ) {
    super(`Invalid persisted data in ${filePath}: ${message}`);
    this.name = "PersistentDataError";
  }
}

export class ConcurrentFileModificationError extends Error {
  readonly code = "ECONCURRENTMODIFICATION";

  constructor(readonly filePath: string) {
    super(`File changed while the edit was being prepared: ${filePath}. Re-read it and retry the edit.`);
    this.name = "ConcurrentFileModificationError";
  }
}

export interface AtomicWriteOptions {
  mode?: number;
  preserveMode?: boolean;
  beforeCommit?: () => void | Promise<void>;
}

async function atomicReplaceFile(
  filePath: string,
  options: AtomicWriteOptions,
  write: (handle: fs.FileHandle) => Promise<void>,
): Promise<void> {
  const parent = path.dirname(filePath);
  await fs.mkdir(parent, { recursive: true });
  const previousMode = options.preserveMode === false ? undefined : await existingMode(filePath);
  const mode = options.mode ?? previousMode ?? 0o666;
  const enforceMode = options.mode !== undefined || previousMode !== undefined;
  const tempPath = temporaryPath(filePath);
  let handle: fs.FileHandle | undefined;

  try {
    handle = await fs.open(
      tempPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW,
      mode,
    );
    if (enforceMode && process.platform !== "win32") await handle.chmod(mode);
    await write(handle);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await options.beforeCommit?.();
    await fs.rename(tempPath, filePath);
    await syncDirectory(parent);
  } catch (error) {
    await handle?.close().catch(() => {});
    await fs.unlink(tempPath).catch(() => {});
    throw error;
  }
}

function temporaryPath(filePath: string): string {
  const suffix = randomBytes(8).toString("hex");
  return path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${suffix}.tmp`);
}

async function existingMode(filePath: string): Promise<number | undefined> {
  try {
    const stat = await fs.lstat(filePath);
    if (stat.isSymbolicLink()) throw new Error(`Refusing to replace symbolic link: ${filePath}`);
    if (!stat.isFile()) throw new Error(`Expected a regular file: ${filePath}`);
    return stat.mode & 0o777;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function existingModeSync(filePath: string): number | undefined {
  try {
    const stat = lstatSync(filePath);
    if (stat.isSymbolicLink()) throw new Error(`Refusing to replace symbolic link: ${filePath}`);
    if (!stat.isFile()) throw new Error(`Expected a regular file: ${filePath}`);
    return stat.mode & 0o777;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function writeAll(handle: fs.FileHandle, data: Uint8Array, startPosition = 0): Promise<void> {
  let offset = 0;
  while (offset < data.byteLength) {
    const result = await handle.write(data, offset, data.byteLength - offset, startPosition + offset);
    if (result.bytesWritten === 0) throw new Error("File write made no progress");
    offset += result.bytesWritten;
  }
}

function writeAllSync(fd: number, data: Uint8Array): void {
  let offset = 0;
  while (offset < data.byteLength) {
    const bytesWritten = writeSync(fd, data, offset, data.byteLength - offset, offset);
    if (bytesWritten === 0) throw new Error("File write made no progress");
    offset += bytesWritten;
  }
}

export async function syncDirectory(dirPath: string): Promise<void> {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(dirPath, constants.O_RDONLY | DIRECTORY_FLAG);
    await handle.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (process.platform === "win32" && ["EACCES", "EBADF", "EINVAL", "EISDIR", "ENOTSUP", "EPERM"].includes(code ?? "")) {
      return;
    }
    throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

export function syncDirectorySync(dirPath: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(dirPath, constants.O_RDONLY | DIRECTORY_FLAG);
    fsyncSync(fd);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (process.platform === "win32" && ["EACCES", "EBADF", "EINVAL", "EISDIR", "ENOTSUP", "EPERM"].includes(code ?? "")) {
      return;
    }
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export async function atomicWriteFile(
  filePath: string,
  content: string | Uint8Array,
  options: AtomicWriteOptions = {},
): Promise<void> {
  const data = typeof content === "string" ? Buffer.from(content, "utf8") : content;
  await atomicReplaceFile(filePath, options, (handle) => writeAll(handle, data));
}

export async function atomicWriteFileFromHandle(
  filePath: string,
  sourceHandle: fs.FileHandle,
  options: AtomicWriteOptions = {},
): Promise<void> {
  await atomicReplaceFile(filePath, options, async (targetHandle) => {
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let offset = 0;
    for (;;) {
      const { bytesRead } = await sourceHandle.read(buffer, 0, buffer.length, offset);
      if (bytesRead === 0) return;
      await writeAll(targetHandle, buffer.subarray(0, bytesRead), offset);
      offset += bytesRead;
    }
  });
}

export function atomicWriteFileSync(
  filePath: string,
  content: string | Uint8Array,
  options: Omit<AtomicWriteOptions, "beforeCommit"> = {},
): void {
  const parent = path.dirname(filePath);
  mkdirSync(parent, { recursive: true });
  const previousMode = options.preserveMode === false ? undefined : existingModeSync(filePath);
  const mode = options.mode ?? previousMode ?? 0o666;
  const enforceMode = options.mode !== undefined || previousMode !== undefined;
  const tempPath = temporaryPath(filePath);
  const data = typeof content === "string" ? Buffer.from(content, "utf8") : content;
  let fd: number | undefined;

  try {
    fd = openSync(
      tempPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW,
      mode,
    );
    if (enforceMode && process.platform !== "win32") fchmodSync(fd, mode);
    writeAllSync(fd, data);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tempPath, filePath);
    syncDirectorySync(parent);
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    try {
      unlinkSync(tempPath);
    } catch {
      // Nothing to clean up.
    }
    throw error;
  }
}

export async function withFileLock<T>(
  filePath: string,
  operation: () => Promise<T>,
): Promise<T> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const release = await lockfile.lock(filePath, FILE_LOCK_OPTIONS);
  try {
    return await operation();
  } finally {
    await release();
  }
}

export function withFileLockSync<T>(filePath: string, operation: () => T): T {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const release = lockfile.lockSync(filePath, FILE_LOCK_OPTIONS);
  try {
    return operation();
  } finally {
    release();
  }
}

export function parsePersistedJson<T>(filePath: string, content: string): T {
  try {
    return JSON.parse(content) as T;
  } catch (error) {
    throw new PersistentDataError(filePath, error instanceof Error ? error.message : String(error));
  }
}
