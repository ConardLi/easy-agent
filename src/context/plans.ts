/**
 * Plan file management — create, read, and locate plan files on disk.
 *
 * Plans live in ~/.easy-agent/plans/ and use a random slug per session scope.
 * The model writes its plan to this file during plan mode; the user
 * can edit the file before approving exit.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { getPlansRoot } from "../utils/paths.js";
import { ensurePrivateDirectory, writePrivateFile } from "../utils/privateData.js";
import { defineSessionState } from "../state/sessionScope.js";

/** Each session scope gets its own plan file, named on first use. */
const planSlug = defineSessionState<{ value: string | null }>("planSlug", () => ({ value: null }));

function generateSlug(): string {
  return crypto.randomBytes(4).toString("hex");
}

export function getPlanSlug(): string {
  const slug = planSlug();
  if (!slug.value) {
    slug.value = generateSlug();
  }
  return slug.value;
}

export function resetPlanSlug(): void {
  planSlug().value = null;
}

export function getPlansDirectory(): string {
  return getPlansRoot();
}

export function getPlanFilePath(): string {
  return path.join(getPlansRoot(), `${getPlanSlug()}.md`);
}

export async function ensurePlansDirectory(): Promise<void> {
  await ensurePrivateDirectory(getPlansRoot());
}

export async function writePlan(content: string): Promise<string> {
  await ensurePlansDirectory();
  const filePath = getPlanFilePath();
  await writePrivateFile(filePath, content);
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
