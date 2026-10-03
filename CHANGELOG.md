# Changelog

All notable changes to Easy Agent are documented in this file.

## [Unreleased]

### Added

- `dist/THIRD_PARTY_LICENSES.txt` with the license text of every third-party package inlined into the bundle. The build fails on a license outside the allowlist.
- The release gate scans the bundled application code with the source hygiene rules, scans the packed tarball for credentials and stray files, and starts the installed CLI in Headless and interactive mode.
- README sections on use cases, supported platforms, the security model, configuration precedence, and data locations.

### Changed

- The npm description and keywords describe product capabilities.
- The development milestone table moved from the README to `docs/learning-path.md`.
- The tool-turn limit per request is configurable with `--max-turns <n>` or the `maxTurns` setting. The interactive REPL default rises from 50 to 200, and reaching the limit explains how to continue. Headless runs keep the 50-turn default and the `error_max_turns` result.
- `verify:release` also runs the host sandbox tests. The release workflow runs the gate on macOS and Ubuntu and the core tests on Windows before publishing, and publishes the verified artifact without rebuilding it.

## [0.1.1] - 2026-09-04

### Changed

- Updated the public project status after the first npm publication and registry cold-cache verification.

## [0.1.0] - 2026-08-15

### Added

- First npm-distributable Easy Agent CLI release.
- Single-file ESM bundle with source maps and no runtime dependency tree.
- Node.js 22 runtime gate, npm package boundary checks, and release verification.
- npm-backed macOS/Linux installer and provenance-enabled tag release workflow.

### Changed

- The npm package and primary command are named `eagent`.
- `easy-agent` is installed as the long command alias.
- The former development-only `agent` command is no longer registered because it is ambiguous and collision-prone.
