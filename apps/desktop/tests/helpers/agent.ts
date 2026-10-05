import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// The repository's scripted Anthropic API; the Agent the app starts talks to it instead of a real provider.
import { type AnthropicFixture, createAnthropicFixture, FIXTURE_MODEL } from "../../../../src/scripts/fixtures/anthropicFixture";

export interface AgentWorld {
  fixture: AnthropicFixture;
  /** Environment for the app: an isolated home and the fixture as the model provider. */
  env: Record<string, string>;
  /** A project folder to open as a workspace. */
  project: string;
  home: string;
}

/** A scripted model, an empty home directory, and a small project. */
export async function createAgentWorld(): Promise<AgentWorld> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "easy-agent-desktop-world-")));
  const home = join(root, "home");
  const project = join(root, "demo-project");
  mkdirSync(join(home, ".easy-agent"), { recursive: true });
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, "README.md"), "# Demo\n\nA project for desktop tests.");

  const fixture = createAnthropicFixture();
  await fixture.start();
  return {
    fixture,
    project,
    home,
    env: {
      HOME: home,
      USERPROFILE: home,
      ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL ?? "",
      ANTHROPIC_AUTH_TOKEN: "fixture-token",
      ANTHROPIC_MODEL: FIXTURE_MODEL,
      EASY_AGENT_DISABLE_HOOKS: "1",
      EASY_AGENT_ENABLE_TOOL_SEARCH: "false",
      NO_COLOR: "1",
    },
  };
}
