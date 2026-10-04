/**
 * Writes docs/rpc-protocol.schema.json from the protocol definitions in
 * src/rpc/protocol.ts. `--check` fails when the checked-in file is stale.
 *
 * Run: node --import tsx scripts/generate-rpc-schema.ts [--check]
 */

import { readFile, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildRpcJsonSchema } from "../src/rpc/protocol.js";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCHEMA_PATH = path.join(PROJECT_ROOT, "docs", "rpc-protocol.schema.json");

const expected = `${JSON.stringify(buildRpcJsonSchema(), null, 2)}\n`;

if (process.argv.includes("--check")) {
  const actual = await readFile(SCHEMA_PATH, "utf8").catch(() => "");
  if (actual !== expected) {
    process.stderr.write("docs/rpc-protocol.schema.json is out of date. Run: npm run rpc:schema\n");
    process.exit(1);
  }
  process.stdout.write("RPC schema: docs/rpc-protocol.schema.json is current.\n");
} else {
  await writeFile(SCHEMA_PATH, expected);
  process.stdout.write(`Wrote ${path.relative(PROJECT_ROOT, SCHEMA_PATH)}\n`);
}
