#!/usr/bin/env tsx

import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  buildSandboxProfile,
  annotateSandboxFailure,
  cleanupSandboxCommand,
  getSandboxCapability,
  resetSandboxRuntime,
  wrapWithSandbox,
  DEFAULT_RESOLVED_SANDBOX_SETTINGS,
  type ResolvedSandboxSettings,
} from "../sandbox/index.js";

const capability = getSandboxCapability();
if (!capability.supported) {
  console.error(`Sandbox host test does not support ${process.platform}.`);
  process.exit(1);
}
if (!capability.available) {
  console.error(`Sandbox dependencies unavailable: ${capability.errors.join("; ")}`);
  process.exit(1);
}

const failures: string[] = [];
function expect(label: string, condition: unknown, evidence?: string): void {
  if (condition) console.log(`  ✓ ${label}`);
  else {
    console.log(`  ✗ ${label}${evidence ? `\n      ${evidence}` : ""}`);
    failures.push(label);
  }
}

function settings(
  filesystem: Partial<ResolvedSandboxSettings["filesystem"]> = {},
  network: Partial<ResolvedSandboxSettings["network"]> = {},
): ResolvedSandboxSettings {
  return {
    ...DEFAULT_RESOLVED_SANDBOX_SETTINGS,
    enabled: true,
    filesystem: { ...DEFAULT_RESOLVED_SANDBOX_SETTINGS.filesystem, ...filesystem },
    network: { ...DEFAULT_RESOLVED_SANDBOX_SETTINGS.network, ...network },
  };
}

async function runSandboxed(
  cwd: string,
  command: string,
  resolved: ResolvedSandboxSettings,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const profile = buildSandboxProfile({ cwd, settings: resolved, permissions: { allow: [], deny: [] } });
  const wrapped = await wrapWithSandbox({ command, cwd, profile });
  const [executable, ...args] = wrapped.argv;
  if (!executable) throw new Error("sandbox runtime returned an empty command");
  const result = await new Promise<{
    status: number | null;
    stdout: string;
    stderr: string;
    error?: Error;
  }>((resolve) => {
    const child = spawn(executable, args, { cwd, env: wrapped.env });
    let stdout = "";
    let stderr = "";
    let spawnError: Error | undefined;
    const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once("error", (error) => { spawnError = error; });
    child.once("close", (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr, error: spawnError });
    });
  });
  const stderr = annotateSandboxFailure(
    wrapped.commandId,
    result.stderr || result.error?.message || "",
    result.status,
  );
  cleanupSandboxCommand(wrapped);
  return {
    code: result.status ?? -1,
    stdout: result.stdout,
    stderr,
  };
}

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "easy-agent-sandbox-host-"));

async function main(): Promise<void> {
  console.log(`Sandbox backend: ${capability.backend}`);

  console.log("\n[1] allowed writes and normal process behavior");
  const allowedFile = path.join(testRoot, "allowed.txt");
  const allowed = await runSandboxed(
    testRoot,
    `printf allowed > '${allowedFile}' && printf stdout && printf stderr >&2 && exit 7`,
    settings(),
  );
  expect("configured write succeeds", fs.readFileSync(allowedFile, "utf8") === "allowed");
  expect("stdout is preserved", allowed.stdout === "stdout", JSON.stringify(allowed.stdout));
  expect("stderr is preserved", allowed.stderr.includes("stderr"), JSON.stringify(allowed.stderr));
  expect("exit code is preserved", allowed.code === 7, `exit=${allowed.code}`);

  console.log("\n[2] denyWrite overrides an allowed working directory");
  const deniedDirectory = path.join(testRoot, "blocked-write");
  const deniedFile = path.join(deniedDirectory, "canary.txt");
  fs.mkdirSync(deniedDirectory);
  const deniedWrite = await runSandboxed(
    testRoot,
    `printf blocked > '${deniedFile}'`,
    settings({ denyWrite: [deniedDirectory] }),
  );
  expect("denied write fails", deniedWrite.code !== 0, `exit=${deniedWrite.code}`);
  expect("denied file is absent", !fs.existsSync(deniedFile));

  console.log("\n[3] denyRead is enforced");
  const secret = path.join(testRoot, "secret.txt");
  fs.writeFileSync(secret, "host-secret");
  const deniedRead = await runSandboxed(
    testRoot,
    `cat '${secret}'`,
    settings({ denyRead: [secret] }),
  );
  expect("denied read fails", deniedRead.code !== 0, `exit=${deniedRead.code}`);
  expect("secret content is not returned", !deniedRead.stdout.includes("host-secret"));

  console.log("\n[4] domain policy is enforced by the network proxy");
  await resetSandboxRuntime();
  const domain = "example.com";
  const url = `https://${domain}/`;
  const preflight = spawnSync("curl", ["--max-time", "10", "--silent", "--show-error", "--fail", url], {
    encoding: "utf8",
  });
  expect("network test endpoint is reachable", preflight.status === 0, preflight.stderr);
  const defaultNetwork = await runSandboxed(
    testRoot,
    `curl --noproxy '' --max-time 5 --silent --show-error --fail '${url}'`,
    settings(),
  );
  expect("public network works without an allowlist", defaultNetwork.code === 0, defaultNetwork.stderr);
  expect("default network response is returned", defaultNetwork.stdout.includes("Example Domain"));
  const networkSettings = settings({}, { allowedDomains: [domain] });
  const proxyProbe = await runSandboxed(
    testRoot,
    `node -e "const u=new URL(process.env.HTTPS_PROXY);const s=require('node:net').connect(Number(u.port),u.hostname,()=>{console.log('proxy-connected');s.end()});s.on('error',e=>{console.error(e.code);process.exit(1)})"`,
    networkSettings,
  );
  expect("sandbox can reach its network proxy", proxyProbe.code === 0, proxyProbe.stderr);
  const allowedNetwork = await runSandboxed(
    testRoot,
    `curl --noproxy '' --max-time 5 --silent --show-error --fail '${url}'`,
    networkSettings,
  );
  expect("allowlisted destination succeeds", allowedNetwork.code === 0, allowedNetwork.stderr);
  expect("allowlisted response is returned", allowedNetwork.stdout.includes("Example Domain"));
  const unmatchedNetwork = await runSandboxed(
    testRoot,
    `curl --noproxy '' --max-time 5 --silent --show-error --fail '${url}'`,
    settings({}, { allowedDomains: ["api.invalid.example"] }),
  );
  expect("configured allowlist blocks unmatched destinations", unmatchedNetwork.code !== 0, unmatchedNetwork.stderr);
  const deniedNetwork = await runSandboxed(
    testRoot,
    `curl --noproxy '' --max-time 5 --silent --show-error --fail '${url}'`,
    settings({}, { allowedDomains: [domain], deniedDomains: [domain] }),
  );
  expect("denylist takes precedence", deniedNetwork.code !== 0, `exit=${deniedNetwork.code}`);
  expect("denied response is not returned", !deniedNetwork.stdout.includes("Example Domain"));

  console.log("\n[5] concurrent commands keep independent network policies");
  const [delayedAllowed, concurrentDenied] = await Promise.all([
    runSandboxed(
      testRoot,
      `sleep 1 && curl --noproxy '' --max-time 5 --silent --show-error --fail '${url}'`,
      networkSettings,
    ),
    runSandboxed(
      testRoot,
      `curl --noproxy '' --max-time 5 --silent --show-error --fail '${url}'`,
      settings({}, { deniedDomains: [domain] }),
    ),
  ]);
  expect("allowed command keeps its allowlist", delayedAllowed.code === 0, delayedAllowed.stderr);
  expect("concurrent denied command remains blocked", concurrentDenied.code !== 0, concurrentDenied.stderr);

  console.log("");
  if (failures.length > 0) {
    console.error(`${failures.length} sandbox host test(s) failed.`);
    process.exitCode = 1;
  } else {
    console.log("All sandbox host tests passed.");
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await resetSandboxRuntime().catch(() => {});
    fs.rmSync(testRoot, { recursive: true, force: true });
  });
