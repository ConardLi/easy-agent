import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import {
  getEasyAgentHome,
  getEasyAgentPath,
  getGlobalAgentMdPath,
  getLocalSettingsPath,
  getStatePath,
  getStreamDebugLogPath,
  getUserSettingsPath,
} from "./paths.js";
import {
  atomicWriteFile,
  atomicWriteFileSync,
  syncDirectory,
} from "./atomicFile.js";

export const PRIVATE_DIRECTORY_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;

const MIGRATION_MARKER = ".permissions-v1";
const NO_FOLLOW = fs.constants.O_NOFOLLOW ?? 0;
const POSIX_PERMISSIONS = process.platform !== "win32";

export interface PrivateDataIssue {
  path: string;
  message: string;
}

export interface PrivateDataSecurityReport {
  supported: boolean;
  migrated: boolean;
  issues: PrivateDataIssue[];
}

let lastSecurityReport: PrivateDataSecurityReport | null = null;

function modeString(mode: number): string {
  return `0${(mode & 0o777).toString(8)}`;
}

function unsafePath(filePath: string, reason: string): Error {
  return new Error(`Refusing private-data path ${filePath}: ${reason}`);
}

async function requireDirectory(dirPath: string): Promise<void> {
  const stat = await fsp.lstat(dirPath);
  if (stat.isSymbolicLink()) throw unsafePath(dirPath, "symbolic links are not supported");
  if (!stat.isDirectory()) throw unsafePath(dirPath, "expected a directory");
}

function requireDirectorySync(dirPath: string): void {
  const stat = fs.lstatSync(dirPath);
  if (stat.isSymbolicLink()) throw unsafePath(dirPath, "symbolic links are not supported");
  if (!stat.isDirectory()) throw unsafePath(dirPath, "expected a directory");
}

async function secureOpenedFile(handle: fsp.FileHandle, filePath: string): Promise<void> {
  const stat = await handle.stat();
  if (!stat.isFile()) throw unsafePath(filePath, "expected a regular file");
  if (POSIX_PERMISSIONS) await handle.chmod(PRIVATE_FILE_MODE);
}

function secureOpenedFileSync(fd: number, filePath: string): void {
  const stat = fs.fstatSync(fd);
  if (!stat.isFile()) throw unsafePath(filePath, "expected a regular file");
  if (POSIX_PERMISSIONS) fs.fchmodSync(fd, PRIVATE_FILE_MODE);
}

export async function ensurePrivateDirectory(dirPath: string): Promise<void> {
  await fsp.mkdir(dirPath, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  await requireDirectory(dirPath);
  if (POSIX_PERMISSIONS) await fsp.chmod(dirPath, PRIVATE_DIRECTORY_MODE);
}

export function ensurePrivateDirectorySync(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  requireDirectorySync(dirPath);
  if (POSIX_PERMISSIONS) fs.chmodSync(dirPath, PRIVATE_DIRECTORY_MODE);
}

export async function writePrivateFile(
  filePath: string,
  data: string | Uint8Array,
  options: { secureParent?: boolean } = {},
): Promise<void> {
  if (options.secureParent === false) {
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
  } else {
    await ensurePrivateDirectory(path.dirname(filePath));
  }
  await atomicWriteFile(filePath, data, {
    mode: PRIVATE_FILE_MODE,
    preserveMode: false,
  });
}

export function writePrivateFileSync(filePath: string, data: string | Uint8Array): void {
  ensurePrivateDirectorySync(path.dirname(filePath));
  atomicWriteFileSync(filePath, data, {
    mode: PRIVATE_FILE_MODE,
    preserveMode: false,
  });
}

export async function appendPrivateFile(
  filePath: string,
  data: string | Uint8Array,
): Promise<void> {
  await ensurePrivateDirectory(path.dirname(filePath));
  const handle = await fsp.open(
    filePath,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND | NO_FOLLOW,
    PRIVATE_FILE_MODE,
  );
  try {
    await secureOpenedFile(handle, filePath);
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close().catch(() => {});
  }
}

export function appendPrivateFileSync(filePath: string, data: string | Uint8Array): void {
  ensurePrivateDirectorySync(path.dirname(filePath));
  const fd = fs.openSync(
    filePath,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND | NO_FOLLOW,
    PRIVATE_FILE_MODE,
  );
  try {
    secureOpenedFileSync(fd, filePath);
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

export async function createPrivateFileIfMissing(
  filePath: string,
  data = "",
): Promise<boolean> {
  await ensurePrivateDirectory(path.dirname(filePath));
  let handle: fsp.FileHandle;
  try {
    handle = await fsp.open(
      filePath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NO_FOLLOW,
      PRIVATE_FILE_MODE,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = await fsp.open(filePath, fs.constants.O_WRONLY | NO_FOLLOW);
    try {
      await secureOpenedFile(existing, filePath);
    } finally {
      await existing.close().catch(() => {});
    }
    return false;
  }
  try {
    await secureOpenedFile(handle, filePath);
    if (data) await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close().catch(() => {});
  }
  await syncDirectory(path.dirname(filePath));
  return true;
}

async function hardenExistingPath(
  target: string,
  expectedType: "file" | "directory",
  issues: PrivateDataIssue[],
): Promise<void> {
  let stat: fs.Stats;
  try {
    stat = await fsp.lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    issues.push({ path: target, message: (error as Error).message });
    return;
  }
  if (stat.isSymbolicLink()) {
    issues.push({ path: target, message: "symbolic link skipped" });
    return;
  }
  const typeMatches = expectedType === "directory" ? stat.isDirectory() : stat.isFile();
  if (!typeMatches) {
    issues.push({ path: target, message: `expected ${expectedType}` });
    return;
  }
  if (!POSIX_PERMISSIONS) return;
  try {
    await fsp.chmod(
      target,
      expectedType === "directory" ? PRIVATE_DIRECTORY_MODE : PRIVATE_FILE_MODE,
    );
  } catch (error) {
    issues.push({ path: target, message: (error as Error).message });
  }
}

async function hardenTree(
  root: string,
  issues: PrivateDataIssue[],
  options: { files: boolean },
): Promise<void> {
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    issues.push({ path: root, message: (error as Error).message });
    return;
  }

  await hardenExistingPath(root, "directory", issues);
  for (const entry of entries) {
    const child = path.join(root, entry.name);
    if (entry.isSymbolicLink()) {
      issues.push({ path: child, message: "symbolic link skipped" });
    } else if (entry.isDirectory()) {
      await hardenTree(child, issues, options);
    } else if (entry.isFile() && options.files) {
      await hardenExistingPath(child, "file", issues);
    }
  }
}

export async function hardenPrivateDataStorage(options: {
  forceMigration?: boolean;
  projectCwd?: string;
} = {}): Promise<PrivateDataSecurityReport> {
  const issues: PrivateDataIssue[] = [];
  const home = getEasyAgentHome();

  try {
    await ensurePrivateDirectory(home);
  } catch (error) {
    issues.push({ path: home, message: (error as Error).message });
    const report = { supported: POSIX_PERMISSIONS, migrated: false, issues };
    lastSecurityReport = report;
    return report;
  }

  if (!POSIX_PERMISSIONS) {
    const report = { supported: false, migrated: false, issues };
    lastSecurityReport = report;
    return report;
  }

  const directDirectories = [
    "projects",
    "tasks",
    "teams",
    "plans",
    "file-history",
    "plugins",
    path.join("plugins", "data"),
  ].map((entry) => getEasyAgentPath(entry));
  const directFiles = [
    getUserSettingsPath(),
    getStatePath(),
    getStreamDebugLogPath(),
    getGlobalAgentMdPath(),
  ];

  for (const dir of directDirectories) await hardenExistingPath(dir, "directory", issues);
  for (const file of directFiles) await hardenExistingPath(file, "file", issues);
  if (options.projectCwd) {
    await hardenExistingPath(getLocalSettingsPath(options.projectCwd), "file", issues);
  }

  const marker = getEasyAgentPath(MIGRATION_MARKER);
  const alreadyMigrated = await fsp.access(marker).then(() => true, () => false);
  let migrated = alreadyMigrated && !options.forceMigration;
  if (!migrated) {
    for (const name of ["projects", "tasks", "teams", "plans"]) {
      await hardenTree(getEasyAgentPath(name), issues, { files: true });
    }
    // Backups retain source mode because /rewind uses it when restoring files.
    await hardenTree(getEasyAgentPath("file-history"), issues, { files: false });
    if (issues.length === 0) {
      try {
        await writePrivateFile(marker, "1\n");
        migrated = true;
      } catch (error) {
        issues.push({ path: marker, message: (error as Error).message });
      }
    }
  }

  const report = { supported: true, migrated, issues };
  lastSecurityReport = report;
  return report;
}

async function inspectMode(
  target: string,
  expectedType: "file" | "directory",
  issues: PrivateDataIssue[],
): Promise<void> {
  let stat: fs.Stats;
  try {
    stat = await fsp.lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    issues.push({ path: target, message: (error as Error).message });
    return;
  }
  if (stat.isSymbolicLink()) {
    issues.push({ path: target, message: "symbolic link cannot be verified" });
    return;
  }
  const typeMatches = expectedType === "directory" ? stat.isDirectory() : stat.isFile();
  if (!typeMatches) {
    issues.push({ path: target, message: `expected ${expectedType}` });
    return;
  }
  const expectedMode = expectedType === "directory" ? PRIVATE_DIRECTORY_MODE : PRIVATE_FILE_MODE;
  if ((stat.mode & 0o777) !== expectedMode) {
    issues.push({
      path: target,
      message: `mode ${modeString(stat.mode)}; expected ${modeString(expectedMode)}`,
    });
  }
}

export async function inspectPrivateDataSecurity(
  projectCwd?: string,
): Promise<PrivateDataSecurityReport> {
  if (!POSIX_PERMISSIONS) {
    return { supported: false, migrated: false, issues: [] };
  }
  const issues: PrivateDataIssue[] = [];
  await inspectMode(getEasyAgentHome(), "directory", issues);
  for (const dir of [
    "projects",
    "tasks",
    "teams",
    "plans",
    "file-history",
    "plugins",
    path.join("plugins", "data"),
  ]) {
    await inspectMode(getEasyAgentPath(dir), "directory", issues);
  }
  for (const file of [
    getUserSettingsPath(),
    getStatePath(),
    getStreamDebugLogPath(),
    getGlobalAgentMdPath(),
    getEasyAgentPath(MIGRATION_MARKER),
  ]) {
    await inspectMode(file, "file", issues);
  }
  if (projectCwd) {
    await inspectMode(getLocalSettingsPath(projectCwd), "file", issues);
  }
  return {
    supported: true,
    migrated: await fsp.access(getEasyAgentPath(MIGRATION_MARKER)).then(() => true, () => false),
    issues,
  };
}

export function getLastPrivateDataSecurityReport(): PrivateDataSecurityReport | null {
  return lastSecurityReport;
}
