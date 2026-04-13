import * as os from "node:os";
import * as path from "node:path";

const EASY_AGENT_GLOBAL_ROOT = path.join(os.homedir(), ".easy-agent");

export function getToolAllowedRoots(cwd: string): string[] {
  return [path.resolve(cwd), path.resolve(EASY_AGENT_GLOBAL_ROOT)];
}

export function describeAllowedRoots(cwd: string): string {
  return getToolAllowedRoots(cwd).join(", ");
}

export function expandHome(filePath: string): string {
  return filePath.startsWith("~")
    ? filePath.replace("~", process.env.HOME || "")
    : filePath;
}

export function resolveSafePath(filePath: string, cwd: string): string {
  return path.resolve(cwd, expandHome(filePath));
}

export function ensureInsideAllowedRoots(resolvedPath: string, cwd: string): void {
  const normalizedPath = path.resolve(resolvedPath);
  for (const root of getToolAllowedRoots(cwd)) {
    const relative = path.relative(root, normalizedPath);
    if (relative === "" || relative === ".") return;
    if (!relative.startsWith("..") && !path.isAbsolute(relative)) {
      return;
    }
  }
  throw new Error(
    `Path is outside the allowed roots: ${resolvedPath}. Allowed roots: ${describeAllowedRoots(cwd)}`,
  );
}

export function resolveWorkspacePath(filePath: string, cwd: string): string {
  const resolvedPath = resolveSafePath(filePath, cwd);
  ensureInsideAllowedRoots(resolvedPath, cwd);
  return resolvedPath;
}
