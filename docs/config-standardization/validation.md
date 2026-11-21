# Configuration standardization validation

Local acceptance completed on macOS, 2026-11-21, against the configuration standardization plan. CI results are recorded in the pull request checks.

The additional saved-profile/legacy-credential precedence regression has been fixed. The complete release gate passed again, followed by all 123 desktop tests. The new real-App regression verifies requests, migration, restart and authentication headers with unused conflicting legacy credentials.

| Check | Result |
|---|---|
| Core types, lint, format, source hygiene, frontend boundaries, inventory and build | Passed |
| Production regressions | 91/91 groups, no skips |
| Local platform/sandbox checks | 2/2 |
| Request-record performance | 2/2; p95 0.29 ms, record/transcript ratio 0.77 |
| Additional connection-precedence checks | 39/39 contract/connection/lifecycle, 53/53 Harness, both trust checks |
| Release/package/installed CLI, SDK, RPC, ACP and installer | 72/72 |
| Four-protocol authentication | 12 actual controlled HTTP requests: default, custom header and none for each protocol |
| Final full desktop acceptance | 123/123: 63 unit, 52 e2e, 8 pixel visual |
| Final readable-control adjustment | 79/79: 63 unit, 8 configuration e2e, 8 pixel visual |
| Configuration/automatic-budget screenshot run | 4/4 |
| Style reference | Typecheck and build passed |
| Bilingual documentation site | Typecheck, static build and link check passed |
| Workspace companion patch | Apply and reverse verified against exact original bytes, with SHA-256 manifest |

The real Electron tests use the built app, real Agent processes, isolated HOME directories and a controlled model. They verify canonical save/reload, connection checks, unknown profile rejection, safe migration preview, exact private backup/reload, credential conflicts, helper ownership, custom authentication and explicit no-auth behavior. No-model startup remains usable for configuration. Unset reasoning budgets display as automatic and can be set and cleared without writing zero.

Saved connections retain their declared credential values and sources under named/inline Agent, CLI/SDK, policy and single-profile selection. Missing references, invalid canonical values and needed legacy conflicts still fail. Same-file unused conflicts can migrate safely; newly generated legacy profiles retain their original credential.

Only five goldens changed for the plan's intentional behavior adjustments: CLI help/diagnostics, canonical Harness hashes, supported Sonnet 4.0 manual reasoning, conservative unknown-provider reasoning and verified reasoning-off mappings. Permission-decision goldens were unchanged. Existing pixel baselines, thresholds and masks were unchanged.

The eight existing pixel scenarios cover first launch and request context/comparison. The following eight new states were manually inspected; they do not claim a complete pixel baseline for model and migration pages:

| Screenshot | Coverage |
|---|---|
| [No model configured](./screenshots/no-profile-configuration.png) | Helpful startup/configuration state and readable model roles |
| [Migration preview](./screenshots/migration-preview.png) | Redacted diff, notices and backup/apply action |
| [Reload after migration](./screenshots/migration-reloaded.png) | Canonical saved selection survives restart |
| [Credential conflict](./screenshots/migration-conflict.png) | Neither secret displayed; apply disabled |
| [Custom authentication](./screenshots/profile-helper-custom-auth.png) | One API Key source and a declared header/prefix |
| [Profile helper](./screenshots/profile-helper-advanced.png) | Helper ownership and retained protected command |
| [No authentication](./screenshots/profile-no-auth.png) | Explicit no-auth endpoint with no credential header |
| [Automatic budget, control detail](./screenshots/reasoning-budget-auto.png) | Honest unset state, positive-budget edit and clear |

Full raw local logs accompany the workspace delivery in `config-standardization-validation/logs/`. The [field mapping and rollback guide](../configuration-migration.md), [profile contract](../model-profiles.md), and [companion patch instructions](./README.md) describe migration, trust, source priority and compatibility removal at the next explicitly announced breaking release. No version/date was invented. Real `.env` files, historical tutorial snapshots and the read-only reference repository were not modified; no npm release was published.
