/**
 * Built as `dist/sdk.js`, the `eagent/sdk` entry. It is the public SDK
 * (`index.ts`, which also provides the declarations) plus the experimental
 * exports under an internal name, which `eagent/sdk/experimental` re-exports
 * so both entries share one module instance.
 */

export * from "./index.js";
export * as __experimental from "./experimental.js";
