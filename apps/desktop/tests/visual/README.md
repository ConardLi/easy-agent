# Visual comparison with the style reference

The style reference (`web-ui/`, kept outside this repository) decides how the client looks. Each scenario in `scenarios.ts` is a state of the reference, opened with URL parameters, and the preferences that put the client in the same state. `baseline/<name>.png` is the reference's screenshot of that state.

`npm run test:visual` starts the built client for every scenario and compares its window with the baseline. Native traffic lights and the OS user name differ for reasons other than styling, so elements marked `data-visual-mask` are painted over on both sides.

## Capturing the baseline

The baseline only ever comes from the reference (`updateSnapshots` is `none`), so a client change cannot make its own screenshot the new standard.

1. Start the reference: `npm run dev` in `web-ui/` (port 5180).
2. In `apps/desktop/`: `WEB_UI_URL=http://localhost:5180 npm run visual:baseline`.

The reference is rendered in the same Electron build as the client, at a 1280×800 viewport and a device scale factor of 1, so fonts and compositing match. Chinese text falls back to the system's CJK font, whose glyphs change between macOS versions, so a baseline only holds on the machine (or macOS version) that captured it. CI runs the e2e tests only; run `npm run test:visual` locally before a pull request that touches the interface, and capture the baseline again after a macOS upgrade.

## When the design changes

Change the reference first, capture the baseline again, then change the client until `npm run test:visual` passes. New states the client needs get a reference state (a URL parameter) and a scenario before the client implements them.
