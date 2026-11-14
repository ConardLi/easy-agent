/**
 * Live check of request rendering against real providers (needs real model
 * profiles and keys; not part of verify:production).
 *
 * For each model handle given: start a runtime whose Agent uses that model,
 * render the first request for a prompt (counting every `fetch` while it
 * renders), then send the same prompt in a real session and compare the
 * first request the provider received, component by component: ids, sizes,
 * and hashes of the system prompt sections, tool schemas, and messages, and
 * the request parameters. Rendering must make no network call.
 *
 * Run from a workspace whose settings define the profiles:
 *   npx tsx scripts/verify-harness-diff-live.ts MiniMax-M3 gpt5-M claude
 */

import assert from "node:assert/strict";

const handles = process.argv.slice(2);
if (handles.length === 0) {
  console.error("Usage: npx tsx scripts/verify-harness-diff-live.ts <model handle>...");
  process.exit(2);
}
const cwd = process.cwd();
const PROMPT = "只回复 OK 两个字母，不要调用任何工具。";

const { createAgentRuntime } = await import("../src/sdk/runtime.js");
const { runInScopeOf } = await import("../src/sdk/session.js");
const { renderFirstRequest } = await import("../src/sdk/renderRequest.js");
const { getLatestMainRequest } = await import("../src/trace/requestTrace.js");
type Record = NonNullable<ReturnType<typeof getLatestMainRequest>>["record"];

let fetches = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = (...args: Parameters<typeof fetch>) => {
  fetches++;
  return realFetch(...args);
};

/** Every component of a request with its size and hash, in request order. */
function shape(record: Pick<Record, "system" | "tools" | "messages">) {
  return {
    system: record.system.segments.map(({ component, bytes, hash }) => ({ component, bytes, hash })),
    tools: record.tools.segments.map(({ component, bytes, hash }) => ({ component, bytes, hash })),
    messages: record.messages.segments.map(({ component, bytes, hash, parts }) => ({
      component,
      bytes,
      hash,
      parts: parts?.map(({ source, bytes: size, hash: digest }) => ({ source, bytes: size, hash: digest })),
    })),
  };
}

let failed = 0;
for (const handle of handles) {
  const runtime = await createAgentRuntime({
    cwd,
    hardenPrivateData: false,
    services: { mcpServers: true, wait: true },
    harness: { spec: { extends: "default", model: { main: handle } } },
  });
  try {
    const harness = await runtime.getHarness();
    fetches = 0;
    const rendered = await renderFirstRequest(cwd, harness, PROMPT);
    const renderFetches = fetches;

    const session = await runtime.createSession({ persist: false, interactions: [], autoWake: false });
    fetches = 0;
    const turn = await session.send(PROMPT);
    const sendFetches = fetches;
    const real = runInScopeOf(session, () => getLatestMainRequest())?.record;
    const reply = session
      .getState()
      .messages.filter((message) => message.role === "assistant")
      .map((message) =>
        typeof message.content === "string"
          ? message.content
          : message.content.map((block) => (block.type === "text" ? block.text : `[${block.type}]`)).join(""),
      )
      .join(" | ");
    await session.close();

    assert.equal(renderFetches, 0, "rendering made no network call");
    assert.ok(sendFetches > 0, "the real turn went through fetch, so the counter works");
    assert.ok(real, `the real session recorded a request (turn ${turn.reason ?? "ended"})`);
    assert.ok(real.result && !real.result.error, `the real request succeeded (${real.result?.error ?? ""})`);
    assert.equal(real.messages.count, rendered.record.messages.count, "the model answered without a tool call");
    assert.deepEqual(
      { protocol: real.protocol, model: real.model.sent },
      { protocol: rendered.record.protocol, model: rendered.record.model.sent },
    );
    const { promptCacheKey: _realKey, ...realParams } = real.params;
    const { promptCacheKey: _renderedKey, ...renderedParams } = rendered.record.params;
    assert.deepEqual(renderedParams, realParams, "request parameters");
    assert.deepEqual(shape(rendered.record), shape(real), "every component matches by id, size, and hash");
    console.log(
      `  ✓ ${handle} (${real.protocol}, ${real.model.sent}): ${real.system.segments.length} system parts, ` +
        `${real.tools.count} tools, ${real.messages.count} message(s) identical; rendering made 0 requests, ` +
        `the real turn ${sendFetches}; provider input ${real.result.usage.input_tokens} tokens; reply ${JSON.stringify(reply.slice(0, 40))}`,
    );
  } catch (error) {
    failed++;
    console.error(`  ✗ ${handle}: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await runtime.dispose();
  }
}
globalThis.fetch = realFetch;
console.log(failed === 0 ? `\n${handles.length} model(s) checked.` : `\n${failed} of ${handles.length} failed.`);
process.exit(failed === 0 ? 0 : 1);
