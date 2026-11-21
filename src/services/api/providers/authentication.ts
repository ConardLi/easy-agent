import { ConfigurationError } from "../../../config/values.js";
import { isAuthenticationHeader } from "../../../config/modelSchema.js";
import type { ModelProfile } from "./profile.js";

/** All transports, including model discovery, use this exact authentication contract. */
export function profileRequestHeaders(profile: ModelProfile): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(profile.headers ?? {})) {
    if (isAuthenticationHeader(name) || /[\r\n]/.test(value)) {
      throw new ConfigurationError(
        `models.${profile.id}.headers`,
        "put authentication in the profile's single API Key policy.",
      );
    }
    headers[name.toLowerCase()] = value;
  }
  const policy = profile.authentication ?? { type: "default" };
  if (policy.type === "none") return headers;
  if (!profile.apiKey?.trim() || /[\r\n]/.test(profile.apiKey)) {
    throw new ConfigurationError(
      `models.${profile.id}.apiKey`,
      "provide this profile's API Key, or explicitly select authentication.type=none for an unauthenticated endpoint.",
    );
  }
  const name =
    policy.type === "header"
      ? policy.name.toLowerCase()
      : profile.protocol === "anthropic"
        ? "x-api-key"
        : profile.protocol === "gemini"
          ? "x-goog-api-key"
          : "authorization";
  if (headers[name] !== undefined) {
    throw new ConfigurationError(
      `models.${profile.id}.headers`,
      "custom headers cannot override the authentication policy.",
    );
  }
  const prefix =
    policy.type === "header" ? (policy.prefix ?? "") : profile.protocol.startsWith("openai-") ? "Bearer " : "";
  headers[name] = prefix + profile.apiKey;
  return headers;
}
