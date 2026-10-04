/**
 * Session-stable system prompt and tail context updates.
 *
 * The system prompt is built once per session (date at day precision, git
 * as a session-start snapshot) and stays byte-identical across turns. Later
 * changes to AGENT.md, memory, settings, output style, or the date arrive
 * as a hidden `[context_update]` message before the user's prompt. /clear,
 * compaction, and resume rebuild the prompt.
 *
 * Run: node --import tsx src/scripts/test-session-prompt-context.ts
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages.js";

const root = await mkdtemp(path.join(os.tmpdir(), "easy-agent-session-prompt-"));
const home = path.join(root, "home");
const cwd = path.join(root, "project");
await Promise.all([mkdir(path.join(home, ".easy-agent"), { recursive: true }), mkdir(cwd, { recursive: true })]);
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.EASY_AGENT_DISABLE_HOOKS = "1";
process.env.EASY_AGENT_ENABLE_TOOL_SEARCH = "false";
delete process.env.EASY_AGENT_DISABLE_PROMPT_CACHING;
process.chdir(cwd);

const gitAvailable = (() => {
  try {
    execFileSync("git", ["init", "-q"], { cwd });
    execFileSync(
      "git",
      ["-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "initial"],
      { cwd },
    );
    return true;
  } catch {
    return false;
  }
})();

const { createSessionPromptContext, CONTEXT_UPDATE_MARKER } = await import("../context/sessionPromptContext.js");
const { renderSystemPrompt, getLocalDateString } = await import("../context/systemPrompt.js");
const { setCustomOutputStyles, setActiveOutputStyle, clearOutputStyles } = await import("../styles/registry.js");
const { isInternalMessage } = await import("../ui/components/ConversationView.js");

let passed = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const AGENT_MD = path.join(cwd, "AGENT.md");
const USER_SETTINGS = path.join(home, ".easy-agent", "settings.json");
let clock = new Date(2026, 9, 3, 23, 50, 0);
const now = () => clock;

try {
  console.log("\n[1] SessionPromptContext");

  const context = createSessionPromptContext({ cwd, now });
  const first = await context.prepareTurn({ userQuery: "hello" });
  const firstPrompt = renderSystemPrompt(first.systemParts);

  await check("the first turn builds the prompt with a day-precision date and no update", () => {
    assert.equal(first.update, null);
    assert.ok(firstPrompt.includes(`- Today's date: ${getLocalDateString(clock)}`));
    assert.doesNotMatch(firstPrompt, /\d{2}:\d{2}:\d{2}/, "no clock time in the prompt");
    if (gitAvailable) assert.match(firstPrompt, /Git status at session start \(a snapshot/);
  });

  await check("an unchanged workspace produces the same prompt and no update", async () => {
    clock = new Date(2026, 9, 3, 23, 55, 0);
    const turn = await context.prepareTurn({ userQuery: "again" });
    assert.equal(renderSystemPrompt(turn.systemParts), firstPrompt);
    assert.equal(turn.update, null);
  });

  await check("git changes do not touch the prompt (session-start snapshot)", async () => {
    await writeFile(path.join(cwd, "new-file.txt"), "x");
    const turn = await context.prepareTurn();
    assert.equal(renderSystemPrompt(turn.systemParts), firstPrompt);
    assert.equal(turn.update, null);
  });

  await check("an AGENT.md change arrives as a tail update, once", async () => {
    await writeFile(AGENT_MD, "Use tabs for indentation.\n");
    const changed = await context.prepareTurn();
    assert.equal(renderSystemPrompt(changed.systemParts), firstPrompt, "the prompt itself is unchanged");
    assert.ok(changed.update?.startsWith(`${CONTEXT_UPDATE_MARKER}\n<system-reminder>`));
    assert.match(
      changed.update!,
      /## Project memory \(AGENT\.md\)\nProject memory \(AGENT\.md\):[\s\S]*Use tabs for indentation\./,
    );
    assert.equal((await context.prepareTurn()).update, null, "already reported");
  });

  await check("a removed section is reported as no longer applying", async () => {
    await unlink(AGENT_MD);
    const turn = await context.prepareTurn();
    assert.match(turn.update!, /## Project memory \(AGENT\.md\)\nThis section no longer applies\./);
  });

  await check("a new calendar day is announced once", async () => {
    clock = new Date(2026, 9, 4, 0, 5, 0);
    const turn = await context.prepareTurn();
    assert.match(turn.update!, new RegExp(`## Date\\nToday's date is now ${getLocalDateString(clock)}\\.`));
    assert.equal(renderSystemPrompt(turn.systemParts), firstPrompt);
    assert.equal((await context.prepareTurn()).update, null);
  });

  await check("a settings change (language) is reported", async () => {
    await writeFile(USER_SETTINGS, JSON.stringify({ language: "Japanese" }));
    const turn = await context.prepareTurn();
    assert.match(turn.update!, /## Response language\nRespond to the user in Japanese/);
  });

  await check("a request to skip memory adds a one-turn note without changing tracked state", async () => {
    const turn = await context.prepareTurn({ userQuery: "please don't use memory for this" });
    assert.match(turn.update!, /## Memory\nThe user asked not to use memory for this turn/);
    assert.equal((await context.prepareTurn({ userQuery: "normal question" })).update, null);
  });

  await check(
    "switching output style is a tail update; dropping the coding instructions rebuilds the prompt",
    async () => {
      setCustomOutputStyles([
        {
          name: "Terse",
          description: "short",
          prompt: "Answer in one line.",
          source: "user",
          keepCodingInstructions: true,
        },
        {
          name: "Owned",
          description: "own",
          prompt: "Only follow this style.",
          source: "user",
          keepCodingInstructions: false,
        },
      ]);
      assert.ok(setActiveOutputStyle("Terse"));
      const terse = await context.prepareTurn();
      assert.equal(renderSystemPrompt(terse.systemParts), firstPrompt);
      assert.match(terse.update!, /## Output style\n# Output Style: Terse\nAnswer in one line\./);

      assert.ok(setActiveOutputStyle("Owned"));
      const owned = await context.prepareTurn();
      const ownedPrompt = renderSystemPrompt(owned.systemParts);
      assert.notEqual(ownedPrompt, firstPrompt);
      assert.ok(ownedPrompt.includes("# Output Style: Owned"));
      assert.ok(!ownedPrompt.includes("Prefer specialized tools over shell"), "coding instructions dropped");
      assert.equal(owned.update, null, "the rebuilt prompt already carries the change");
      clearOutputStyles();
      await context.prepareTurn();
    },
  );

  await check("reset rebuilds the prompt from the current state", async () => {
    await writeFile(AGENT_MD, "Prefer small commits.\n");
    context.reset();
    const turn = await context.prepareTurn();
    assert.equal(turn.update, null);
    const prompt = renderSystemPrompt(turn.systemParts);
    assert.ok(prompt.includes("Prefer small commits."));
    assert.ok(prompt.includes(`- Today's date: ${getLocalDateString(clock)}`));
    assert.ok(prompt.includes("Respond to the user in Japanese"));
  });

  await check("peekSystemParts does not consume pending changes", async () => {
    await writeFile(AGENT_MD, "Prefer small commits.\nRun the linter.\n");
    const before = renderSystemPrompt(await context.peekSystemParts());
    const turn = await context.prepareTurn();
    assert.equal(renderSystemPrompt(turn.systemParts), before);
    assert.match(turn.update!, /Run the linter\./);
  });

  await check("the update message is hidden from the transcript view", () => {
    assert.equal(
      isInternalMessage({ role: "user", content: `${CONTEXT_UPDATE_MARKER}\n<system-reminder>x</system-reminder>` }),
      true,
    );
    assert.equal(isInternalMessage({ role: "user", content: "context_update is a normal word" }), false);
  });

  console.log("\n[2] QueryEngine");

  await writeFile(USER_SETTINGS, "{}");
  await rm(AGENT_MD, { force: true });
  const requests: Array<{ system: string; messages: MessageParam[] }> = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        system?: unknown;
        messages: MessageParam[];
        tools?: unknown[];
      };
      if (Array.isArray(body.tools)) {
        const system = Array.isArray(body.system)
          ? (body.system as Array<{ text: string }>).map((block) => block.text).join("\n\n")
          : String(body.system ?? "");
        requests.push({ system, messages: body.messages });
      }
      const sse = (name: string, data: unknown) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        [
          sse("message_start", {
            type: "message_start",
            message: {
              id: `m${requests.length}`,
              type: "message",
              role: "assistant",
              model: "fixture-model",
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 5, output_tokens: 0 },
            },
          }),
          sse("content_block_start", {
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "" },
          }),
          sse("content_block_delta", {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "ok" },
          }),
          sse("content_block_stop", { type: "content_block_stop", index: 0 }),
          sse("message_delta", {
            type: "message_delta",
            delta: { stop_reason: "end_turn", stop_sequence: null },
            usage: { output_tokens: 1 },
          }),
          sse("message_stop", { type: "message_stop" }),
        ].join(""),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.ANTHROPIC_AUTH_TOKEN = "fixture-token";
  const { QueryEngine } = await import("../core/queryEngine.js");

  try {
    const engine = new QueryEngine({
      model: "fixture-model",
      toolContext: { cwd, sessionId: "session-test", requestUserQuestion: async () => null },
      permissionMode: "default",
      onPermissionRequest: async () => "deny",
    });
    const submit = async (text: string): Promise<void> => {
      const run = engine.submitMessage(text);
      let step = await run.next();
      while (!step.done) step = await run.next();
    };
    const textOf = (message: MessageParam | undefined): string =>
      typeof message?.content === "string"
        ? message.content
        : ((message?.content as Array<{ type: string; text?: string }> | undefined)
            ?.map((block) => block.text ?? "")
            .join("") ?? "");

    await check("consecutive turns send a byte-identical system prompt", async () => {
      await submit("first question");
      await writeFile(path.join(cwd, "touched.txt"), "changes git status");
      await submit("second question");
      assert.equal(requests.length, 2);
      assert.equal(requests[1]!.system, requests[0]!.system);
    });

    await check("a mid-session AGENT.md change goes into a hidden message before the prompt", async () => {
      await writeFile(AGENT_MD, "Always answer in haiku.\n");
      await submit("third question");
      const last = requests.at(-1)!;
      assert.equal(last.system, requests[0]!.system);
      const messages = last.messages;
      assert.equal(textOf(messages.at(-1)), "third question");
      assert.ok(textOf(messages.at(-2)).startsWith(CONTEXT_UPDATE_MARKER));
      assert.match(textOf(messages.at(-2)), /Always answer in haiku\./);
      const state = engine.getState().messages;
      assert.ok(
        state.some((message) => textOf(message).startsWith(CONTEXT_UPDATE_MARKER)),
        "kept in the conversation",
      );
    });

    await check("/clear rebuilds the prompt with the current workspace state", async () => {
      const clear = engine.submitMessage("/clear");
      let step = await clear.next();
      while (!step.done) step = await clear.next();
      await submit("after clear");
      const last = requests.at(-1)!;
      assert.notEqual(last.system, requests[0]!.system);
      assert.ok(last.system.includes("Always answer in haiku."));
      assert.ok(!last.messages.some((message) => textOf(message).startsWith(CONTEXT_UPDATE_MARKER)));
    });
  } finally {
    server.close();
  }
} finally {
  // Windows cannot remove the process's current directory.
  process.chdir(os.tmpdir());
  await rm(root, { recursive: true, force: true });
}

console.log(`\nSession prompt context: ${passed} passed, 0 failed.`);
