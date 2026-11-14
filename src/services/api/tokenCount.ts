/**
 * Token counting — the provider's count of a request's input tokens by part.
 *
 * The Anthropic Messages API counts a request without running it
 * (`POST /v1/messages/count_tokens`), but only as a whole. The parts are
 * found by difference against a one-message probe:
 *
 *   system   = count(system + probe) − count(probe)
 *   tools    = count(tools + probe)  − count(probe)
 *   messages = count(request)        − system − tools
 *
 * so they add up to the count of the request. The system prompt and the
 * tool list rarely change within a session; their counts (and the probe's)
 * are kept by content, which leaves one call per request once they are known.
 * Whatever the tools add to the request besides their schemas counts with the
 * tools; the request's own framing counts with the messages.
 *
 * The first-party API counts by default. Other Anthropic-compatible endpoints
 * rarely have the endpoint, so a profile opts in with `countTokens: true`. An
 * endpoint that rejects counting is not asked again for that model until the
 * process restarts.
 */

import { createHash } from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";
import { APIError } from "@anthropic-ai/sdk";
import type { MessageCountTokensParams, MessageParam } from "@anthropic-ai/sdk/resources/messages.js";
import type { RequestTokenCount } from "../../trace/requestTrace.js";
import { debugLog } from "../../utils/log.js";
import { getProfileBaseURL, type ModelProfile } from "./providers/profile.js";

const COUNT_TIMEOUT_MS = 15_000;
const MAX_CACHED = 128;
const PROBE: MessageParam[] = [{ role: "user", content: "." }];

/** Whether requests to `profile` are counted: Anthropic protocol, the first-party API or an opted-in profile. */
export function shouldCountTokens(profile: ModelProfile): boolean {
  if (profile.protocol !== "anthropic") return false;
  if (profile.countTokens !== undefined) return profile.countTokens;
  try {
    return new URL(getProfileBaseURL(profile)).hostname === "api.anthropic.com";
  } catch {
    return false;
  }
}

/** The fields of a sent request that count toward its input. */
export interface CountableRequest {
  model: string;
  system?: unknown;
  tools?: readonly object[];
  messages: readonly MessageParam[];
  thinking?: unknown;
  outputConfig?: unknown;
  toolChoice?: unknown;
}

/** Endpoints, by `<baseURL>|<model>`, that rejected counting. */
const unsupported = new Set<string>();
/** Counts of probes and of probes with a system prompt or tool list, by content. */
const cached = new Map<string, Promise<number>>();

const digest = (value: unknown): string =>
  createHash("sha256")
    .update(JSON.stringify(value) ?? "")
    .digest("hex");

/** The endpoint answered, and will answer the same way again. */
function isRejection(error: unknown): boolean {
  if (!(error instanceof APIError) || typeof error.status !== "number") return false;
  return error.status >= 400 && error.status < 500 && ![408, 409, 413, 429].includes(error.status);
}

class NoCountError extends Error {}

/**
 * Count `request` as `client` would send it, by part. Never rejects: an
 * endpoint without counting gives `unsupported`, any other error `failed`.
 */
export async function countRequestTokens(
  client: Anthropic,
  profile: ModelProfile,
  request: CountableRequest,
  headers: Record<string, string>,
): Promise<RequestTokenCount> {
  const endpoint = `${getProfileBaseURL(profile)}|${request.model}`;
  if (unsupported.has(endpoint)) return { status: "unsupported" };
  // Serializing the request again waits until the request itself is on its way.
  await new Promise<void>((resolve) => setImmediate(resolve));

  const shared = {
    model: request.model,
    ...(request.thinking !== undefined ? { thinking: request.thinking } : {}),
    ...(request.outputConfig !== undefined ? { output_config: request.outputConfig } : {}),
  };
  const count = async (body: object): Promise<number> => {
    const response = await client.messages.countTokens(body as MessageCountTokensParams, {
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
      maxRetries: 0,
      timeout: COUNT_TIMEOUT_MS,
    });
    if (typeof response?.input_tokens !== "number" || !Number.isFinite(response.input_tokens)) {
      throw new NoCountError("the response has no input_tokens");
    }
    return response.input_tokens;
  };
  const scope = `${endpoint}|${headers["anthropic-beta"] ?? ""}|${digest(shared)}`;
  const remembered = (key: string, body: () => object): Promise<number> => {
    const id = `${scope}|${key}`;
    const known = cached.get(id);
    if (known) {
      cached.delete(id);
      cached.set(id, known);
      return known;
    }
    const pending = count(body());
    cached.set(id, pending);
    if (cached.size > MAX_CACHED) cached.delete(cached.keys().next().value!);
    pending.catch(() => {
      if (cached.get(id) === pending) cached.delete(id);
    });
    return pending;
  };

  const hasSystem = request.system !== undefined;
  const hasTools = request.tools !== undefined && request.tools.length > 0;
  const toolChoice = request.toolChoice !== undefined ? { tool_choice: request.toolChoice } : {};
  try {
    const [total, probe, withSystem, withTools] = await Promise.all([
      count({
        ...shared,
        ...(hasSystem ? { system: request.system } : {}),
        ...(hasTools ? { tools: request.tools, ...toolChoice } : {}),
        messages: request.messages,
      }),
      hasSystem || hasTools ? remembered("probe", () => ({ ...shared, messages: PROBE })) : Promise.resolve(0),
      hasSystem
        ? remembered(`system:${digest(request.system)}`, () => ({ ...shared, system: request.system, messages: PROBE }))
        : Promise.resolve(0),
      hasTools
        ? remembered(`tools:${digest([request.tools, request.toolChoice])}`, () => ({
            ...shared,
            tools: request.tools,
            ...toolChoice,
            messages: PROBE,
          }))
        : Promise.resolve(0),
    ]);
    const system = hasSystem ? withSystem - probe : 0;
    const tools = hasTools ? withTools - probe : 0;
    const messages = total - system - tools;
    if (system < 0 || tools < 0 || messages < 0) {
      debugLog("tokenCount", "inconsistent", { total, probe, withSystem, withTools });
      return { status: "failed" };
    }
    return { status: "counted", system, tools, messages, total };
  } catch (error) {
    const rejected = error instanceof NoCountError || isRejection(error);
    if (rejected) unsupported.add(endpoint);
    debugLog("tokenCount", rejected ? "unsupported" : "failed", {
      ...(error instanceof APIError && typeof error.status === "number" ? { status: error.status } : {}),
      message: error instanceof Error ? error.message : String(error),
    });
    return { status: rejected ? "unsupported" : "failed" };
  }
}
