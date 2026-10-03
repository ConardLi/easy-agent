# Releasing

Easy Agent is published to npm as `eagent` by the tag-triggered [release workflow](../.github/workflows/release.yml). The package contains only:

- `dist/eagent.js`, the single-file ESM bundle with a Node shebang;
- `dist/eagent.js.map`, a source map with relative paths and no embedded source text;
- `dist/THIRD_PARTY_LICENSES.txt`, license texts for every third-party package inlined into the bundle;
- `README.md`, `README.zh-CN.md`, `LICENSE`, and `package.json`.

`@anthropic-ai/sandbox-runtime` is the only runtime dependency. It stays outside the bundle because it resolves signed platform helpers relative to its own package directory, and its version is pinned.

## Bundle decisions

The bundle is not minified. A readable stack trace in a bug report is worth more than a smaller download, and the source map points those traces at real `src/` lines without shipping the sources. Comments in application modules therefore remain in the bundle, so the release gate scans them with the same source hygiene rules as `src/`.

`npm run build` derives the list of inlined packages from the source map and writes their license files into `THIRD_PARTY_LICENSES.txt`. The build fails if a bundled package declares a license outside the allowlist in `scripts/third-party-notices.ts` (MIT, ISC, BSD-2-Clause, BSD-3-Clause, Apache-2.0, 0BSD, CC0-1.0, BlueOak-1.0.0, Unlicense). Review the license before adding a dependency that would extend the list.

## Release gate

```bash
npm run verify:release
```

The gate runs, in order:

1. `verify:production`: typecheck, source hygiene, build, and the `core`, `extensions`, and `ui` test groups.
2. `verify:production:platform`: real host sandbox tests on macOS and Linux. Linux needs `bubblewrap`, `socat`, `rg`, and unprivileged user namespaces; the tests are skipped on Windows.
3. `src/scripts/test-stage36.ts`, the artifact checks:
   - package metadata, pinned runtime dependency, and a product-focused description and keyword list;
   - README files carry no roadmap progress and every relative link resolves;
   - bundle hygiene (`scripts/check-source-hygiene.ts --bundle dist/eagent.js`), no bundled test scripts, no absolute build-machine paths, and a source map without embedded sources;
   - third-party notices match the current bundle (`scripts/third-party-notices.ts --check`);
   - the `npm pack` file list, then the extracted tarball is scanned for env files, sessions, logs, source trees, token-shaped strings, and the values of credentials present in the local `.env` or environment;
   - installation into an isolated global prefix, both command names, `--help`, Headless text and JSON output against a local fixture provider, and an interactive start in a pseudo-terminal through the trust prompt to the REPL and a clean Ctrl+D exit (macOS and Linux, needs `python3`);
   - the installer script and the old-Node failure path.

The artifact checks also run on every push in the `Release artifact` CI job (`npm run test:stage36`).

## Publishing a version

1. Update `version` in `package.json` and move the `Unreleased` entries in `CHANGELOG.md` under the new version.
2. Run `npm run verify:release` locally.
3. Commit, then tag and push: `git tag v<version> && git push origin v<version>`.

The workflow then:

- checks the Node 20 failure path;
- runs the core tests on macOS and Windows;
- runs the full release gate on macOS;
- runs the full release gate on Ubuntu with the sandbox dependencies installed;
- confirms that the tag matches `package.json`;
- publishes with provenance.

Versions with a prerelease suffix (`1.2.0-rc.1`) go to the `next` dist-tag; others go to `latest`. The publish step uses `--ignore-scripts` so that the artifact verified in the same job is the one uploaded.

After publication, check the registry copy from a clean cache:

```bash
npm_config_cache="$(mktemp -d)" npx --yes eagent@latest --version
```
