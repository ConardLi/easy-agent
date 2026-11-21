# Workspace companion changes

`workspace.patch` contains the authorized changes outside the `easy-agent` Git repository: the desktop style reference in `web-ui`, bilingual `doc-site` content and its configuration widget, workspace `AGENTS.md`, the standardization plan, and the compatibility notes in the earlier Harness plans. Those directories are not Git repositories in this workspace, so their changes are included here for PR review and reproduction.

`manifest.json` records original and resulting SHA-256 values for every changed text file. The patch was checked, applied and reversed against a clean copy of the original files, and its output compared byte-for-byte with the edited workspace.

From the parent workspace containing `easy-agent`, `web-ui`, `doc-site` and `doc`:

```bash
git apply --check easy-agent/docs/config-standardization/workspace.patch
git apply easy-agent/docs/config-standardization/workspace.patch
npm --prefix web-ui run typecheck
npm --prefix web-ui run build
npm --prefix doc-site run typecheck
npm --prefix doc-site run build
npm --prefix doc-site run check:links
```

The patch is already applied in the development workspace. Use a clean original copy to run these commands. To reverse it, use `git apply --reverse` after checking the reverse patch. Existing tutorials, reference code, generated synchronized modules, package dependencies and user credentials are excluded.

Canonical usage is documented in [Model profiles](../model-profiles.md) and [Migration and rollback](../configuration-migration.md). The prototype's Models page accepts `?migration=legacy` and `?migration=conflict` to inspect migration states. Desktop screenshots and the final acceptance report accompany the PR.

Local results and the eight reviewed screenshots are in [Validation](./validation.md). Existing pixel baselines cover startup and request views; new model/migration states are covered by real configuration e2e and manual inspection.
