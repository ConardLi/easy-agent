# Configuration standardization validation

Acceptance date: 2026-11-22, macOS. This report covers the removal of configuration converters, retired-name registries and migration entry points. Earlier compatibility and manual-migration results do not validate this version. Final-commit CI evidence is recorded in [PR #172](https://github.com/ConardLi/easy-agent/pull/172).

| Check | Result |
|---|---|
| Core types, lint, format, source hygiene, frontend boundaries, inventory and build | Passed |
| Production regressions | 91/91 groups, no skips |
| Local platform/sandbox checks | 2/2 |
| Request-record performance | 2/2; p95 0.35 ms, record/transcript ratio 0.77 |
| Release/package/installed CLI, SDK, RPC, ACP and installer | 73/73 |
| Connection and configuration lifecycle checks | 25/25 |
| Harness resolver | 42/42 |
| Harness features and controlled requests | 20/20 |
| Desktop types, lint, format and build | Passed |
| Full desktop suite | 122/122: 63 unit, 51 e2e, 8 pixel visual |
| Configuration screenshots | Five refreshed from the passing e2e run and manually inspected |
| Style reference | Typecheck and build passed |
| Bilingual documentation site | Typecheck, static build and link check passed |
| Workspace companion patch | 48 files; forward/reverse application and exact bytes verified with SHA-256 manifest |

Only the current schema governs configuration. Unknown settings, Profile and Harness fields use generic validation; no retired-name registry or format converter remains. Unrelated environment variables do not configure the program. Explicit `${VAR}` references can use any name, including vendor names.

The complete `npm run verify:release` command passed after updating the persistence fixtures. The installed-package checks confirm that unknown configuration is rejected before HTTP, without rewriting the original file or exposing its values.

CLI, SDK, RPC, desktop and style-reference migration entry points, their types, generated routes, dedicated tests, guides and screenshots have been removed. Normal editing, connection checks and diagnostics remain available. Invalid initial configuration is reported before credential helpers or model requests execute. A live edit rejected by settings validation preserves the preceding complete source snapshot and exposes the rejection diagnostics. Correcting the file applies the new snapshot. Ordinary writes validate the current schema and preserve the file on failure.

Four-protocol authentication checks send 12 controlled HTTP requests: default, custom header and no authentication for each protocol. Only the selected Profile's credential is sent. Coverage also checks helper ownership, cache invalidation, runtime isolation, source priority, explicit references and missing Profile IDs. Historical sessions require a saved Profile or explicit selection; they do not infer one from the upstream model name.

Trust, permissions, parent credential protection, environment isolation, atomic writes and private storage remain. The workspace trust prompt identifies helpers inside Profiles without executing them. Third-party Skill `${CLAUDE_SKILL_DIR}` and `${CLAUDE_SESSION_ID}` substitutions remain, along with the Anthropic SDK, protocol fields and supported model-name normalization.

Persistence and settings-merge fixtures now use actual schema fields. Eight concurrent settings writers still verify that no writes are lost, while crash recovery, unchanged invalid files and preservation of existing fields retain their assertions.

The real Electron suite uses isolated HOME directories, real Agent processes and a controlled model. The four configuration cases cover first configuration and reasoning-budget edit/clear, unknown settings with zero model requests and unchanged original bytes, ambient vendor credentials that cannot override the selected Profile, and helper/custom authentication save/reload followed by explicit no-auth.

The eight existing pixel scenarios cover first launch and request context/comparison. The model settings screenshots below are separate configuration e2e artifacts; they do not expand the pixel-baseline coverage. Pixel baselines, thresholds and masks are unchanged.

| Screenshot | Coverage |
|---|---|
| [No model configured](./screenshots/no-profile-configuration.png) | Settings remain usable before the first Profile |
| [Custom authentication](./screenshots/profile-helper-custom-auth.png) | One API Key source and a declared header/prefix |
| [Profile helper](./screenshots/profile-helper-advanced.png) | Profile-owned helper command |
| [No authentication](./screenshots/profile-no-auth.png) | Explicit no-auth endpoint without a credential header |
| [Automatic budget](./screenshots/reasoning-budget-auto.png) | Unset state after a positive-budget edit and clear |

Full raw logs accompany the workspace delivery in `config-standardization-validation/logs/`. See the [Profile contract](../model-profiles.md) and [companion patch instructions](./README.md). Real `.env` files, historical tutorial snapshots and the read-only reference repository were not modified. No npm package was published.
