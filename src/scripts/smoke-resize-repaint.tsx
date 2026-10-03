/**
 * Regression test for "token usage line duplicated after a terminal resize"
 * (GitHub issue #1).
 *
 * When the window narrows, the terminal re-wraps rows already on screen, so
 * Ink's line-count erase misses the top of the live frame and leaves a stale
 * copy of the usage line behind on every resize. useResizeRepaint wipes the
 * screen after a width change and remounts <Static> so the history and the
 * live frame are drawn once at the new width.
 *
 * This drives the hook through a real interactive Ink render on a fake TTY and
 * checks: a width change produces exactly one wipe followed by one copy of the
 * history and the live frame; a resize burst collapses into one repaint; a
 * height-only change does nothing; and <Static> appends still print after the
 * key-driven remount.
 */
import React from "react";
import { PassThrough } from "node:stream";
import { Box, Static, Text, render } from "ink";
import { RESIZE_SETTLE_MS, useResizeRepaint } from "../ui/hooks/useResizeRepaint.js";
import { CLEAR_TERMINAL } from "../ui/hooks/useAgentSession/notices.js";

let failures = 0;
function assert(cond: boolean, label: string): void {
  console.log(`${cond ? "  \u2713" : "  \u2717"} ${label}`);
  if (!cond) failures++;
}

interface Item {
  key: string;
  text: string;
}

let setItemsExternal: ((items: Item[]) => void) | null = null;

function Harness(): React.ReactNode {
  const [items, setItems] = React.useState<Item[]>([
    { key: "welcome", text: "WELCOME" },
    { key: "u0", text: "USER_FIRST" },
  ]);
  setItemsExternal = setItems;
  const epoch = useResizeRepaint();
  return (
    <Box flexDirection="column" paddingX={1}>
      <Static key={epoch} items={items}>
        {(item) => (
          <Box key={item.key}>
            <Text>{item.text}</Text>
          </Box>
        )}
      </Static>
      <Box marginTop={1}>
        <Text>USAGE_LINE 1234 tokens</Text>
      </Box>
      <Box width="100%" borderStyle="single" borderLeft={false} borderRight={false}>
        <Text>{"> "}</Text>
      </Box>
    </Box>
  );
}

const count = (haystack: string, needle: string): number => haystack.split(needle).length - 1;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const stream = new PassThrough();
  const fakeStdout = stream as unknown as NodeJS.WriteStream & { columns: number; rows: number; isTTY: boolean };
  fakeStdout.columns = 120;
  fakeStdout.rows = 30;
  fakeStdout.isTTY = true;
  let captured = "";
  stream.on("data", (chunk) => {
    captured += chunk.toString();
  });

  const resize = (columns: number, rows = fakeStdout.rows) => {
    fakeStdout.columns = columns;
    fakeStdout.rows = rows;
    stream.emit("resize");
  };

  const instance = render(<Harness />, {
    stdout: fakeStdout,
    interactive: true,
    patchConsole: false,
    exitOnCtrlC: false,
  });
  await wait(50);
  assert(count(captured, "USER_FIRST") === 1, "history printed once on mount");

  let mark = captured.length;
  resize(80);
  await wait(RESIZE_SETTLE_MS + 80);
  let after = captured.slice(mark);
  assert(count(after, CLEAR_TERMINAL) === 1, "width change wipes screen + scrollback once");
  const repaint = after.slice(after.lastIndexOf(CLEAR_TERMINAL));
  assert(count(repaint, "WELCOME") === 1 && count(repaint, "USER_FIRST") === 1, "history reprinted once after the wipe");
  assert(count(repaint.slice(repaint.lastIndexOf("USER_FIRST")), "USAGE_LINE") === 1, "live frame drawn once below the history");

  mark = captured.length;
  for (const columns of [70, 60, 50, 60, 80]) {
    resize(columns);
    await wait(10);
  }
  await wait(RESIZE_SETTLE_MS + 80);
  after = captured.slice(mark);
  assert(count(after, CLEAR_TERMINAL) === 1, "resize burst ending at the starting width repaints once");

  mark = captured.length;
  resize(80, 20);
  await wait(RESIZE_SETTLE_MS + 80);
  assert(!captured.slice(mark).includes(CLEAR_TERMINAL), "height-only change does not repaint");

  mark = captured.length;
  setItemsExternal?.([
    { key: "welcome", text: "WELCOME" },
    { key: "u0", text: "USER_FIRST" },
    { key: "a1", text: "ASSISTANT_AFTER_RESIZE" },
  ]);
  await wait(50);
  after = captured.slice(mark);
  assert(after.includes("ASSISTANT_AFTER_RESIZE"), "append after remount still prints");
  assert(!after.includes("USER_FIRST"), "append after remount prints only the new item");

  instance.unmount();
  instance.cleanup();

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
