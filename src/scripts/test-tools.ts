#!/usr/bin/env tsx
import { loadEnv } from "../utils/loadEnv.js";
loadEnv();
/**
 * Phase 3 verification script — Test tool interface and FileReadTool.
 *
 * Tests:
 *   1. Tool registry works (getAllTools, findToolByName)
 *   2. FileReadTool can read a file with line numbers
 *   3. FileReadTool handles offset/limit
 *   4. FileReadTool handles errors (missing file)
 *   5. Tools convert to API parameter format
 */

import { getAllTools, findToolByName, getToolsApiParams } from "../tools/index.js";
import type { ToolContext } from "../tools/Tool.js";

const ctx: ToolContext = { cwd: process.cwd() };

async function main() {
  console.log("── Phase 3: Tool Interface Verification ──\n");

  // 1. Registry
  const tools = getAllTools();
  console.log(`✓ getAllTools() returned ${tools.length} tool(s): [${tools.map(t => t.name).join(", ")}]`);

  const readTool = findToolByName("Read");
  if (!readTool) {
    console.error("✗ findToolByName('Read') returned undefined");
    process.exit(1);
  }
  console.log(`✓ findToolByName('Read') → ${readTool.name}`);
  console.log(`  isReadOnly: ${readTool.isReadOnly()}, isEnabled: ${readTool.isEnabled()}`);

  // 2. Read package.json
  console.log("\n── Test: Read package.json ──\n");
  const result = await readTool.call({ file_path: "package.json" }, ctx);
  if (result.isError) {
    console.error(`✗ Error reading package.json: ${result.content}`);
    process.exit(1);
  }
  const lines = result.content.split("\n");
  console.log(`✓ Read package.json (${lines.length} output lines)`);
  // Show first 5 lines
  for (const line of lines.slice(0, 6)) {
    console.log(`  ${line}`);
  }
  console.log("  ...");

  // 3. Read with offset/limit
  console.log("\n── Test: Read with offset=3, limit=5 ──\n");
  const partial = await readTool.call({ file_path: "package.json", offset: 3, limit: 5 }, ctx);
  if (partial.isError) {
    console.error(`✗ Error: ${partial.content}`);
    process.exit(1);
  }
  console.log(`✓ Partial read:`);
  for (const line of partial.content.split("\n").slice(0, 7)) {
    console.log(`  ${line}`);
  }

  // 4. Error handling — missing file
  console.log("\n── Test: Read non-existent file ──\n");
  const missing = await readTool.call({ file_path: "does-not-exist.txt" }, ctx);
  if (!missing.isError) {
    console.error("✗ Expected isError=true for missing file");
    process.exit(1);
  }
  console.log(`✓ Correctly returned error: ${missing.content.split("\n")[0]}`);

  // 5. API params format
  console.log("\n── Test: API parameter conversion ──\n");
  const apiParams = getToolsApiParams();
  console.log(`✓ getToolsApiParams() returned ${apiParams.length} tool(s)`);
  for (const p of apiParams) {
    console.log(`  - ${p.name}: ${p.description?.slice(0, 60)}...`);
    console.log(`    input_schema.properties: [${Object.keys(p.input_schema.properties ?? {}).join(", ")}]`);
  }

  console.log("\n✓ Phase 3 tool verification passed!\n");
}

main().catch((err) => {
  console.error(`\n✗ Fatal: ${err.message}`);
  process.exit(1);
});
