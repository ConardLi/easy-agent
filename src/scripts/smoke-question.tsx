/**
 * Visual smoke for the AskUserQuestion dialog (stage 24). Renders the
 * QuestionPrompt in single-select and multi-select states to a fake stdout so
 * the layout / chip / highlight / markers can be eyeballed without a TTY.
 */
import type React from "react";
import { PassThrough } from "node:stream";
import { Box, render } from "ink";
import chalk from "chalk";
import { QuestionPrompt } from "../ui/components/QuestionPrompt.js";
import type { UserQuestion } from "../tools/Tool.js";

chalk.level = 3;

const single: UserQuestion = {
  question: "想创建哪种类型的测试文件？请结合现有项目的风格选择一个，我会照着它的约定来写。",
  header: "测试类型",
  options: [
    {
      label: "功能冒烟测试 (.ts)",
      description: "参考 test-tasks.ts 的 assert(label) 风格，测试某个具体功能模块",
    },
    { label: "UI 烟雾测试 (.tsx)", description: "参考 smoke-ui.tsx，渲染 Ink 组件并截图验证" },
    { label: "单元测试 (vitest)", description: "用 vitest 风格的 describe/it，标准的 .test.ts 单元测试" },
  ],
};

const multi: UserQuestion = {
  question: "Which test layers do you want?",
  header: "Tests",
  multiSelect: true,
  options: [
    { label: "unit", description: "Pure functions, fast" },
    { label: "component", description: "Ink components via testing-library" },
    { label: "e2e", description: "Full CLI smoke" },
  ],
};

function Demo(): React.ReactNode {
  return (
    <Box flexDirection="column" paddingX={1}>
      <QuestionPrompt questions={[single]} questionIndex={0} highlight={0} selected={new Set()} textInput="" />
      <QuestionPrompt
        questions={[multi]}
        questionIndex={0}
        highlight={3}
        selected={new Set([0, 1])}
        textInput="snapshot tests"
      />
    </Box>
  );
}

async function main(): Promise<void> {
  const fakeStdout = new PassThrough() as unknown as NodeJS.WriteStream;
  let captured = "";
  (fakeStdout as unknown as PassThrough).on("data", (c) => {
    captured += c.toString();
  });
  (fakeStdout as unknown as { columns: number }).columns = 90;
  (fakeStdout as unknown as { rows: number }).rows = 40;

  const instance = render(<Demo />, { stdout: fakeStdout, debug: true, exitOnCtrlC: false });
  await new Promise((r) => setTimeout(r, 80));
  instance.unmount();
  instance.cleanup();

  process.stdout.write(captured + "\n");
}

void main();
