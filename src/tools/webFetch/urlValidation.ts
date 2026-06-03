/**
 * WebFetch URL validation + SSRF guard.
 *
 * Reference: claude-code-source-code/src/tools/WebFetchTool/utils.ts
 * (`validateURL`). The reference additionally relies on an Anthropic-hosted
 * domain blocklist preflight (api.anthropic.com/api/web/domain_info) to catch
 * link-local / metadata endpoints. We have no such service, so we replace that
 * dependency with explicit private/loopback/link-local IP blocking — the
 * "解析后校验非私网 IP" step in the plan.
 */

const MAX_URL_LENGTH = 2000;

export interface UrlValidationResult {
  ok: boolean;
  /** Reason for rejection (only set when ok=false). */
  reason?: string;
}

function isPrivateIPv4(host: string): boolean {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const octets = m.slice(1).map(Number);
  if (octets.some((o) => o > 255)) return true; // malformed → treat as unsafe
  const [a, b] = octets;
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // loopback
  if (a === 0) return true; // "this" network
  if (a === 169 && b === 254) return true; // link-local (cloud metadata 169.254.169.254)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT 100.64.0.0/10
  if (a >= 224) return true; // multicast / reserved
  return false;
}

function isPrivateIPv6(rawHost: string): boolean {
  // URL hostnames keep IPv6 in brackets; strip them.
  const host = rawHost.replace(/^\[|\]$/g, "").toLowerCase();
  if (!host.includes(":")) return false;
  if (host === "::1" || host === "::") return true; // loopback / unspecified
  if (host.startsWith("fe80")) return true; // link-local
  if (host.startsWith("fc") || host.startsWith("fd")) return true; // unique-local fc00::/7
  // IPv4-mapped (::ffff:127.0.0.1 etc.)
  const mapped = host.match(/::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (mapped) return isPrivateIPv4(mapped[1]);
  return false;
}

function isBlockedHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === "localhost") return true;
  if (host.endsWith(".localhost")) return true;
  if (host.endsWith(".local")) return true; // mDNS
  if (host.endsWith(".internal")) return true; // common internal TLD (e.g. GCP metadata)
  if (isPrivateIPv4(host)) return true;
  if (isPrivateIPv6(host)) return true;
  return false;
}

/**
 * Validate a URL for WebFetch. Rejects non-http(s) schemes, embedded
 * credentials, single-label hostnames, and any private/loopback/link-local
 * address (SSRF). Returns a structured result with a model-facing reason.
 */
export function validateFetchUrl(url: string): UrlValidationResult {
  if (typeof url !== "string" || url.length === 0) {
    return { ok: false, reason: "URL is empty" };
  }
  if (url.length > MAX_URL_LENGTH) {
    return { ok: false, reason: `URL exceeds ${MAX_URL_LENGTH} characters` };
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: `Invalid URL "${url}"` };
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, reason: `Unsupported protocol "${parsed.protocol}" (only http/https allowed)` };
  }

  if (parsed.username || parsed.password) {
    return { ok: false, reason: "URLs with embedded credentials are not allowed" };
  }

  const hostname = parsed.hostname;

  if (isBlockedHostname(hostname)) {
    return { ok: false, reason: `Refusing to fetch a private/internal address (${hostname})` };
  }

  // Require a publicly resolvable hostname: at least two labels, unless it's a
  // (public) IP literal — which would already have been caught above if private.
  const isIpLiteral = /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) || hostname.includes(":");
  if (!isIpLiteral && hostname.split(".").length < 2) {
    return { ok: false, reason: `Refusing to fetch non-public hostname "${hostname}"` };
  }

  return { ok: true };
}

export function extractHostname(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}
