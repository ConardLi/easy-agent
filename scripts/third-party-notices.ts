import { readdir, readFile, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const THIRD_PARTY_NOTICES_FILE = "THIRD_PARTY_LICENSES.txt";

/** SPDX identifiers that may be redistributed inside the bundle. */
export const PERMITTED_LICENSES = new Set([
  "0BSD",
  "Apache-2.0",
  "BlueOak-1.0.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "CC0-1.0",
  "ISC",
  "MIT",
  "Unlicense",
]);

export interface BundledPackage {
  name: string;
  version: string;
  license: string;
  licenseTexts: Array<{ file: string; text: string }>;
}

interface PackageManifest {
  name?: string;
  version?: string;
  license?: unknown;
  licenses?: unknown;
}

const LICENSE_FILE = /^(?:licen[cs]e|copying|notice)(?:[.-].*)?$/i;

function packageRootOf(resolvedSource: string): string | undefined {
  const parts = resolvedSource.split(path.sep);
  const index = parts.lastIndexOf("node_modules");
  if (index < 0 || index + 1 >= parts.length) return undefined;
  const nameParts = parts[index + 1]!.startsWith("@") ? 2 : 1;
  return parts.slice(0, index + 1 + nameParts).join(path.sep);
}

function licenseOf(manifest: PackageManifest): string {
  if (typeof manifest.license === "string") return manifest.license;
  if (manifest.license && typeof manifest.license === "object" && "type" in manifest.license) {
    return String((manifest.license as { type: unknown }).type);
  }
  if (Array.isArray(manifest.licenses)) {
    return manifest.licenses
      .map((entry: unknown) =>
        entry && typeof entry === "object" && "type" in entry ? String(entry.type) : String(entry),
      )
      .join(" OR ");
  }
  return "UNKNOWN";
}

/** Splits a simple SPDX expression such as `(MIT OR Apache-2.0)` into identifiers. */
export function licenseIdentifiers(expression: string): string[] {
  return expression
    .replace(/[()]/g, " ")
    .split(/\s+(?:OR|AND)\s+/)
    .map((id) => id.trim())
    .filter(Boolean);
}

export function isPermittedLicense(expression: string): boolean {
  const ids = licenseIdentifiers(expression);
  if (ids.length === 0) return false;
  return /\sAND\s/.test(expression)
    ? ids.every((id) => PERMITTED_LICENSES.has(id))
    : ids.some((id) => PERMITTED_LICENSES.has(id));
}

/**
 * Lists every npm package whose code is inlined into the bundle, derived from
 * the source map that tsup writes next to it.
 */
export async function collectBundledPackages(mapFile: string): Promise<BundledPackage[]> {
  const map = JSON.parse(await readFile(mapFile, "utf8")) as { sources: string[] };
  const roots = new Set<string>();
  for (const source of map.sources) {
    const root = packageRootOf(path.resolve(path.dirname(mapFile), source));
    if (root) roots.add(root);
  }

  const packages: BundledPackage[] = [];
  for (const root of roots) {
    const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")) as PackageManifest;
    const licenseTexts: BundledPackage["licenseTexts"] = [];
    for (const file of (await readdir(root)).filter((entry) => LICENSE_FILE.test(entry)).sort()) {
      licenseTexts.push({ file, text: (await readFile(path.join(root, file), "utf8")).trim() });
    }
    packages.push({
      name: manifest.name ?? path.basename(root),
      version: manifest.version ?? "0.0.0",
      license: licenseOf(manifest),
      licenseTexts,
    });
  }

  return packages.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
}

export function renderThirdPartyNotices(packageName: string, packages: readonly BundledPackage[]): string {
  const rule = "=".repeat(78);
  const sections = packages.map((pkg) => {
    const body =
      pkg.licenseTexts.length > 0
        ? pkg.licenseTexts.map(({ file, text }) => `--- ${file} ---\n${text}`).join("\n\n")
        : `The package does not ship a license file. Its package.json declares the ${pkg.license} license.`;
    return `${rule}\n${pkg.name}@${pkg.version}\nLicense: ${pkg.license}\n${rule}\n\n${body}\n`;
  });

  return [
    `Third-party software bundled in ${packageName}`,
    "",
    `dist/eagent.js includes code from the ${packages.length} packages listed below.`,
    "Each package remains subject to its own license terms.",
    "",
    ...sections,
  ].join("\n");
}

interface NoticeOptions {
  distDir: string;
  mapFile: string;
  packageName: string;
}

async function permittedPackages(mapFile: string): Promise<BundledPackage[]> {
  const packages = await collectBundledPackages(mapFile);
  const rejected = packages.filter((pkg) => !isPermittedLicense(pkg.license));
  if (rejected.length > 0) {
    throw new Error(
      `Bundled packages with unapproved licenses: ${rejected.map((pkg) => `${pkg.name}@${pkg.version} (${pkg.license})`).join(", ")}`,
    );
  }
  return packages;
}

export async function writeThirdPartyNotices(options: NoticeOptions): Promise<BundledPackage[]> {
  const packages = await permittedPackages(options.mapFile);
  await writeFile(
    path.join(options.distDir, THIRD_PARTY_NOTICES_FILE),
    renderThirdPartyNotices(options.packageName, packages),
    "utf8",
  );
  return packages;
}

/** Fails unless the notices file in `distDir` matches the current bundle exactly. */
async function checkThirdPartyNotices(options: NoticeOptions): Promise<void> {
  const packages = await permittedPackages(options.mapFile);
  const file = path.join(options.distDir, THIRD_PARTY_NOTICES_FILE);
  const actual = await readFile(file, "utf8").catch(() => undefined);
  const withoutText = packages.filter((pkg) => pkg.licenseTexts.length === 0).map((pkg) => pkg.name);
  process.stdout.write(
    `Third-party notices: ${packages.length} bundled package(s), all permitted; ` +
      `declared license without shipped text: ${withoutText.join(", ") || "none"}.\n`,
  );
  if (actual !== renderThirdPartyNotices(options.packageName, packages)) {
    process.stdout.write(`${path.relative(process.cwd(), file)} is missing or out of date; run npm run build.\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const { name } = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8")) as { name: string };
  const options = {
    distDir: path.join(projectRoot, "dist"),
    mapFile: path.join(projectRoot, "dist", "eagent.js.map"),
    packageName: name,
  };
  try {
    if (process.argv[2] === "--check" && process.argv.length === 3) await checkThirdPartyNotices(options);
    else if (process.argv.length === 2) await writeThirdPartyNotices(options);
    else throw new Error("Usage: third-party-notices.ts [--check]");
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
