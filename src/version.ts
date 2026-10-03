/**
 * Single source of truth for the product version and outbound identity.
 *
 * `__EAGENT_VERSION__` is substituted at build time from `package.json`
 * (see `tsup.config.ts` → `define`), so the published bundle carries a literal.
 * The alternative — reading `package.json` at runtime — would require
 * `import.meta.url` for path resolution and force `package.json` into the
 * published tarball, both of which we deliberately avoid.
 *
 * Running from a checkout (`npm run dev` via tsx) has no define step, so the
 * `typeof` guard falls back to a dev marker. That is intentional: seeing
 * `0.0.0-dev` in a bug report immediately distinguishes "ran the source tree"
 * from "ran an installed release".
 */
declare const __EAGENT_VERSION__: string | undefined;

/** Runtime floor shared by process preflight and diagnostics. */
export const MIN_NODE_MAJOR = 22;

export const VERSION: string = typeof __EAGENT_VERSION__ === "string" ? __EAGENT_VERSION__ : "0.0.0-dev";

/** Client name reported to peers (MCP `clientInfo`, HTTP User-Agent). */
export const CLIENT_NAME = "easy-agent";

/** Canonical repository, used in the WebFetch User-Agent contact string. */
export const HOMEPAGE = "https://github.com/ConardLi/easy-agent";

/**
 * Outbound User-Agent. Kept in one place so MCP transports, custom Anthropic
 * endpoints and WebFetch never drift apart — a peer that sees three different
 * versions from the same client is impossible to support.
 */
export const USER_AGENT = `${CLIENT_NAME}/${VERSION}`;
