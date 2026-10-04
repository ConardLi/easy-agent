import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "tsup";
import { writeThirdPartyNotices } from "./scripts/third-party-notices.js";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf-8")) as {
  name: string;
  version: string;
};
const projectRoot = fileURLToPath(new URL(".", import.meta.url));

/**
 * Ship one ESM application bundle. Runtime packages that own platform helper
 * assets stay external so Node can resolve those assets from their installed
 * package directory.
 *
 * Application dependencies without runtime assets remain bundled. The sandbox
 * runtime stays external because it resolves signed platform helpers, seccomp
 * filters, and proxy assets relative to its package directory.
 *
 * Intentional trade-offs, not oversights:
 *   - `minify: false` — a readable stack trace in a bug report is worth more
 *     than a smaller file. Comments in application modules stay in the
 *     bundle, so the release gate scans them with the source hygiene rules
 *     and rejects secrets, absolute build paths, and embedded sources.
 *   - `format: "esm"` — the codebase is `type: module`, and a CJS downlevel
 *     would break `import.meta` semantics if assets are ever added.
 *   - `define` for the version — see src/version.ts for why we never read
 *     package.json at runtime.
 */
export default defineConfig({
  // The CLI and the session SDK ship as two self-contained bundles: the SDK
  // bundle leaves out the terminal UI, and `eagent/sdk` resolves to it.
  entry: { eagent: "src/entrypoint/cli.ts", sdk: "src/sdk/index.ts" },
  outDir: "dist",
  format: ["esm"],
  platform: "node",
  target: "node22",
  bundle: true,
  external: ["@anthropic-ai/sandbox-runtime"],
  splitting: false,
  sourcemap: true,
  minify: false,
  // tsup's `treeshake` runs a *second* pass (rollup) over esbuild's output. It
  // buys 0.4% size here (7.12 MB vs 7.09 MB), triples build time, and emits
  // spurious "imported but never used" warnings about Node builtins. esbuild's
  // own DCE during bundling is what actually matters, so the extra pass is off.
  treeshake: false,
  // Wipes any stale `tsc` output so the published dist/ only ever contains the
  // bundle. `prepack` runs this before every pack/publish.
  clean: true,
  // Declarations for the SDK entry. Message types refer to `@anthropic-ai/sdk`,
  // which TypeScript consumers install themselves (see docs/sdk.md).
  dts: {
    entry: { sdk: "src/sdk/index.ts" },
    // tsup sets the deprecated `baseUrl` for the declaration build.
    compilerOptions: { ignoreDeprecations: "6.0" },
  },
  esbuildOptions(options) {
    // Keep the mappings, drop the embedded copies of all 1100+ original
    // sources: 14.1 MB → 3.6 MB. Stack traces still resolve to real
    // `src/**/*.ts` paths and line numbers, which is the only reason we ship a
    // map at all. Anyone who needs the source text has the repository.
    options.sourcesContent = false;
  },
  // Ink declares `react-devtools-core` as an OPTIONAL peer dependency, reached
  // only via `await import('./devtools.js')` behind a `process.env.DEV === true`
  // branch (ink/build/reconciler.js:23). It is not installed and never should
  // be — it would drag the whole React DevTools backend into the artifact.
  //
  // Marking it `external` is NOT enough: esbuild inlines the relative
  // `./devtools.js` and hoists its top-level `import ... from
  // 'react-devtools-core'` to the top of the bundle, where Node resolves it
  // eagerly and the binary dies before `main()` ever runs. So resolve the
  // specifier to an empty stub instead; the branch that would touch it is
  // unreachable in a release build.
  esbuildPlugins: [
    {
      name: "stub-optional-ink-devtools",
      setup(build) {
        build.onResolve({ filter: /^react-devtools-core$/ }, () => ({
          path: "react-devtools-core",
          namespace: "ink-devtools-stub",
        }));
        build.onLoad({ filter: /.*/, namespace: "ink-devtools-stub" }, () => ({
          contents: "export default {};",
          loader: "js",
        }));
      },
    },
  ],
  // Several transitive dependencies are still CommonJS (dotenv, proper-lockfile,
  // he, turndown, cli-highlight...). Bundling CJS into an ESM output makes
  // esbuild emit a `__require` shim that throws `Dynamic require of "fs" is not
  // supported`, because ESM has no `require` in scope. The shim checks
  // `typeof require !== "undefined"` first, so handing the module a real one via
  // `createRequire` is the whole fix.
  //
  // The hashbang is deliberately NOT repeated here: esbuild preserves the entry
  // file's own hashbang and hoists it above this banner. Emitting a second one
  // produces `#!` twice and the output stops being parseable.
  banner: {
    js: [
      "import { createRequire as __eagentCreateRequire } from 'node:module';",
      "const require = __eagentCreateRequire(import.meta.url);",
    ].join("\n"),
  },
  define: { __EAGENT_VERSION__: JSON.stringify(pkg.version) },
  // The bundle inlines third-party packages, so their license texts ship in
  // dist/THIRD_PARTY_LICENSES.txt. The list is derived from the source map and
  // the build fails if a bundled package uses a license outside the allowlist.
  async onSuccess() {
    await writeThirdPartyNotices({
      distDir: `${projectRoot}dist`,
      mapFile: `${projectRoot}dist/eagent.js.map`,
      packageName: pkg.name,
    });
  },
});
