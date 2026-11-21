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

## Resource library navigation (#119)

The reference's `src/components/app/Sidebar.tsx` now labels the resource
library `资源库`, replacing `自定义`. The first-run baselines were captured
again from that reference on macOS 15.7.3 with Electron 44.4.5, at 1280×800
and device scale factor 1.

Only the three screenshots with a visible sidebar changed: each has 399
different RGB pixels, all inside the navigation label at `(43, 150)` to
`(82, 163)` (exclusive end coordinates). The hidden-sidebar baseline is
unchanged. Screenshot thresholds, masks, and scenarios are unchanged, and
all four local visual comparisons pass.

These four scenarios cover the first-run shell. Resource library pages and
Agent assignment are exercised by `tests/e2e/customize.spec.ts`; their saved
screenshots support manual inspection but are not pixel comparison baselines.

## Request detail and comparison (#120)

Four more scenarios cover the context panel and request comparison, each in
dark and light themes. The reference states are `?requestView=context` and
`?requestView=compare` (with `&theme=dark|light`). Their presentation lives in
`web-ui/src/components/requests/`, using the same modal shell and panel width
as the client. The original four first-run baselines are unchanged.

`requestFixtures.ts` contains frozen, SDK-typed `session/context` and request
diff responses. The reference reads these fixtures; `shell.spec.ts` opens a
real workspace in the client and replays only those two RPC responses at the
test IPC boundary. No replay or mock mode ships in the application. The
fixtures stabilize request IDs, sizes, token counts and diff text so the
pixel test measures presentation. `requestSteps.ts` performs the same visible
interactions on both sides, clears hover and lets macOS scrollbars fade.

The context capture covers the panel viewport with the skill source expanded;
the comparison capture covers the dialog content with the identity difference
expanded. No new masks or tolerance changes are used. The four new baselines
were captured on macOS 15.7.3 / Electron 44.4.5 at the existing 1280×800, 1×
viewport. To capture only these states:

```sh
WEB_UI_URL=http://127.0.0.1:5180 npm run visual:baseline -- --grep request-
```

`tests/e2e/requestContext.spec.ts` separately exercises actual Agent requests:
component provenance and provider counts, cache activity, navigation to the
session's Agent, removal of a disabled skill on the next request, two-Agent
comparison without provider calls, identical requests, input invalidation,
failed reads with retry, and late comparison responses. Its screenshots show
the complete application with real RPC data. Pixel replay does not replace
these behavioral tests or claim coverage of every expanded component.
