/**
 * Plan file management — create, read, and locate plan files on disk.
 *
 * Plans live in ~/.easy-agent/plans/ and use a random slug per session.
 * The model writes its plan to this file during plan mode; the user
 * can edit the file before approving exit.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";

const EASY_AGENT_HOME = path.join(os.homedir(), ".easy-agent");
const PLANS_DIR = path.join(EASY_AGENT_HOME, "plans");

let cachedSlug: string | null = null;

function generateSlug(): string {
  return crypto.randomBytes(4).toString("hex");
}

export function getPlanSlug(): string {
  if (!cachedSlug) {
    cachedSlug = generateSlug();
  }
  return cachedSlug;
}

export function resetPlanSlug(): void {
  cachedSlug = null;
}

export function getPlansDirectory(): string {
  return PLANS_DIR;
}

export function getPlanFilePath(): string {
  return path.join(PLANS_DIR, `${getPlanSlug()}.md`);
}

export async function ensurePlansDirectory(): Promise<void> {
  await fs.mkdir(PLANS_DIR, { recursive: true });
}

export async function writePlan(content: string): Promise<string> {
  await ensurePlansDirectory();
  const filePath = getPlanFilePath();
  await fs.writeFile(filePath, content, "utf-8");
  return filePath;
}

export async function readPlan(): Promise<string | null> {
  try {
    return await fs.readFile(getPlanFilePath(), "utf-8");
  } catch (error: unknown) {
    const err = error as NodeJS.ErrnoException;
    if (err?.code === "ENOENT") return null;
    throw error;
  }
}

export async function planExists(): Promise<boolean> {
  try {
    await fs.access(getPlanFilePath());
    return true;
  } catch {
    return false;
  }
}
