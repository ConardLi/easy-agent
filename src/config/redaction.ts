const REDACTED = "[redacted]";

function isSensitiveKey(key: string): boolean {
  const normalized = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
  return [
    "apikey",
    "authorization",
    "cookie",
    "setcookie",
    "accesstoken",
    "authtoken",
    "token",
    "clientsecret",
    "privatekey",
    "password",
    "passwd",
    "credential",
    "credentials",
    "secret",
  ].some((suffix) => normalized === suffix || normalized.endsWith(suffix));
}

export function redactUrlForDisplay(value: string): string {
  try {
    const parsed = new URL(value);
    const hadCredentials = parsed.username.length > 0 || parsed.password.length > 0;
    const hadQuery = parsed.search.length > 0;
    const hadFragment = parsed.hash.length > 0;
    const endpoint = parsed.pathname === "/" ? parsed.origin : `${parsed.origin}/…`;
    return (
      endpoint +
      (hadCredentials ? " [credentials redacted]" : "") +
      (hadQuery ? " [query redacted]" : "") +
      (hadFragment ? " [fragment redacted]" : "")
    );
  } catch {
    return value;
  }
}

function redactNested(value: unknown, key: string): unknown {
  const normalized = key.toLowerCase();
  if (isSensitiveKey(key)) return REDACTED;
  if (normalized === "apikeyhelper") return "[configured]";
  if (normalized === "hooks" || normalized === "statusline") return "[configured]";
  if (normalized === "mcpservers") {
    if (!value || typeof value !== "object" || Array.isArray(value)) return "[configured]";
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>).map((name) => [name, "[configured]"]),
    );
  }

  if (normalized === "env" || normalized === "headers") {
    if (!value || typeof value !== "object" || Array.isArray(value)) return REDACTED;
    return Object.fromEntries(Object.keys(value as Record<string, unknown>).map((name) => [name, REDACTED]));
  }

  if (
    typeof value === "string" &&
    (normalized === "endpoint" || normalized.endsWith("url"))
  ) {
    return redactUrlForDisplay(value);
  }
  if (Array.isArray(value)) return value.map((item) => redactNested(item, ""));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([childKey, childValue]) => [
        childKey,
        redactNested(childValue, childKey),
      ]),
    );
  }
  return value;
}

/** Return a display-safe copy of a setting without credential material. */
export function redactSettingValue(key: string, value: unknown): unknown {
  return redactNested(value, key);
}
