# Configuration standardization validation

Acceptance date: 2026-11-22, macOS. This report covers the canonical-only runtime, including removal of automatic legacy conversion. Earlier compatibility-mode results are not evidence for this version. Exact-commit CI results are recorded in [PR #172](https://github.com/ConardLi/easy-agent/pull/172).

| Check | Result |
|---|---|
| Core types, lint, format, source hygiene, frontend boundaries, inventory and build | Passed |
| Production regressions | 91/91 groups, no skips |
| Local platform/sandbox checks | 2/2 |
| Request-record performance | 2/2; p95 0.34 ms, record/transcript ratio 0.77 |
| Release/package/installed CLI, SDK, RPC, ACP and installer | 76/76 |
| Connection and configuration lifecycle checks | 39/39 |
| Harness resolver | 53/53 |
| Harness features and controlled requests | 21/21 |
| Desktop types, lint and formatting | Passed |
| Full desktop acceptance | 123/123: 63 unit, 52 e2e, 8 pixel visual |
| Final migration and screenshot checks | 5/5 after asserting the model page and reloaded selection are visible |
| Style reference | Typecheck and build passed |
| Bilingual documentation site | Typecheck, static build and link check passed |
| Workspace companion patch | 52 files; forward/reverse application and exact bytes verified with SHA-256 manifest |

Runtime loading, model requests and ordinary saves use the canonical contract only. Retired fields and unreferenced retired environment variables produce actionable errors before helpers or model requests run. A malformed live edit preserves the last valid values while retaining diagnostics that block requests. Missing protocols and unknown profile IDs cannot fall back to Anthropic. Historical sessions do not infer a profile from an upstream model name, even if exactly one profile matches.

The explicit CLI/SDK/RPC migration entry points read original file bytes, preview redacted changes, check revisions, and create exact private backups. Ordinary saves reject retired fields without converting or backing up the file; an explicit edit can remove them. Independent old roles and classifiers retain their original connections only through manual migration. Explicit arbitrary environment references remain valid and never borrow another connection's key. An AST inventory guard prevents production runtime modules from importing the offline converter. The installed-package gate additionally verifies retired environment rejection before HTTP, unchanged old settings on startup, a redacted read-only preview, and explicit migration with an exact original-byte backup.

Four-protocol authentication checks send 12 controlled HTTP requests: default, custom header and none for each protocol. They verify that only the selected profile's credential is sent. Connection lifecycle coverage also checks helper ownership, cache invalidation, runtime isolation, source precedence and missing references. Trust and permission checks retain their existing assertions, including Windows `Path`/`PATH` inheritance.

The real Electron suite runs the built app and real Agent processes with isolated HOME directories and a controlled model. It checks no-model configuration, canonical save/reload, connection checks, migration preview, exact backup, conflicts, helper/custom authentication and explicit no-auth behavior. The retired-credential scenario asserts zero requests before migration, then restarts and verifies the canonical authentication header. Error toasts remain below modal dialogs so they cannot intercept the migration button. An unset reasoning budget displays as automatic and can be set and cleared without writing zero.

The five golden updates correspond to intentional behavior changes in the plan: CLI help/diagnostics, canonical Harness hashes, valid known-model reasoning and conservative unknown-model reasoning. This follow-up did not change those goldens. Permission-decision goldens, pixel baselines, thresholds and masks were unchanged.

The eight existing pixel scenarios cover first launch and request context/comparison. All eight screenshots below were refreshed from the final five migration e2e checks and manually inspected. Those tests now wait for the model page and the reloaded selection to be visible before capturing results, avoiding a screenshot taken during page loading. These screenshots do not constitute a full pixel baseline for model and migration pages.

| Screenshot | Coverage |
|---|---|
| [No model configured](./screenshots/no-profile-configuration.png) | Usable settings before the first profile is configured |
| [Migration preview](./screenshots/migration-preview.png) | Redacted diff, notices and explicit backup/apply action |
| [Reload after migration](./screenshots/migration-reloaded.png) | Canonical saved selection survives restart |
| [Credential conflict](./screenshots/migration-conflict.png) | Neither secret displayed; apply disabled |
| [Custom authentication](./screenshots/profile-helper-custom-auth.png) | One API Key source and a declared header/prefix |
| [Profile helper](./screenshots/profile-helper-advanced.png) | Helper ownership and protected command |
| [No authentication](./screenshots/profile-no-auth.png) | Explicit no-auth endpoint without a credential header |
| [Automatic budget](./screenshots/reasoning-budget-auto.png) | Unset state after positive-budget edit and clear |

Full raw logs accompany the workspace delivery in `config-standardization-validation/logs/`. See the [migration and rollback guide](../configuration-migration.md), [profile contract](../model-profiles.md), and [companion patch instructions](./README.md). This upgrade removes automatic compatibility immediately; only explicit migration remains. Real `.env` files, historical tutorial snapshots and the read-only reference repository were not modified. No npm package was published.
