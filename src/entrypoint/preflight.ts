/**
 * Process preflight — runs before anything else in the binary.
 *
 * This module does its work as an *import side effect* and must stay the first
 * import of the entrypoint. ESM evaluates imports in source order, so anything
 * here happens before the module bodies of later imports. That ordering is the
 * whole point: both concerns below are worthless if some other module already
 * crashed or already produced an unreadable stack trace.
 *
 * 1. Node version gate. `engines` in package.json is advisory — under npm's
 *    default config it prints a warning and installs anyway. So the real gate
 *    has to live inside the binary, and it has to produce a sentence a user can
 *    act on rather than a `SyntaxError` from deep inside a dependency.
 *
 * 2. Source maps. The published bundle ships a `.map` next to it, but Node
 *    ignores source maps unless asked. Without this call the shipped map is
 *    dead weight and every reported stack trace points at bundled line numbers.
 */

import { MIN_NODE_MAJOR } from "../version.js";

export { MIN_NODE_MAJOR };

const nodeMajor = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);

if (Number.isFinite(nodeMajor) && nodeMajor > 0 && nodeMajor < MIN_NODE_MAJOR) {
  process.stderr.write(
    `eagent requires Node.js ${MIN_NODE_MAJOR} or newer — found v${process.versions.node}.\n\n` +
      `Upgrade with a version manager, then re-run:\n` +
      `  nvm install ${MIN_NODE_MAJOR} && nvm use ${MIN_NODE_MAJOR}\n` +
      `  fnm install ${MIN_NODE_MAJOR} && fnm use ${MIN_NODE_MAJOR}\n`,
  );
  process.exit(1);
}

process.setSourceMapsEnabled(true);
