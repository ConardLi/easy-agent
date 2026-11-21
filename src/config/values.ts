/** Configuration errors are safe to display without exposing rejected values. */
export class ConfigurationError extends Error {
  readonly code = "configuration";
  constructor(
    readonly field: string,
    remedy: string,
    readonly source?: string,
  ) {
    super(`${field}${source ? ` (${source})` : ""}: ${remedy}`);
    this.name = "ConfigurationError";
  }
}

export function configString(value: string | undefined): string | undefined {
  return value?.trim() || undefined;
}

export function configBoolean(value: string | undefined, field: string): boolean | undefined {
  const text = configString(value)?.toLowerCase();
  if (text === undefined) return undefined;
  if (["1", "true", "yes", "on"].includes(text)) return true;
  if (["0", "false", "no", "off"].includes(text)) return false;
  throw new ConfigurationError(field, "expected 1/0, true/false, yes/no, or on/off.");
}

export function configInteger(
  value: string | undefined,
  field: string,
  min = 1,
  max = Number.MAX_SAFE_INTEGER,
): number | undefined {
  const text = configString(value);
  if (text === undefined) return undefined;
  const number = Number(text);
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(number) || number < min || number > max) {
    throw new ConfigurationError(field, `expected an integer between ${min} and ${max}.`);
  }
  return number;
}

export function configEnum<T extends string>(
  value: string | undefined,
  field: string,
  options: readonly T[],
): T | undefined {
  const text = configString(value);
  if (text === undefined) return undefined;
  if (!options.includes(text as T)) {
    throw new ConfigurationError(field, `expected ${options.join(", ")}.`);
  }
  return text as T;
}

/** Explicit missing references are errors. They must not select another credential. */
export function resolveEnvironmentReferences(value: string, env: Readonly<NodeJS.ProcessEnv>, field: string): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => {
    const resolved = configString(env[name]);
    if (resolved === undefined) {
      throw new ConfigurationError(
        field,
        `environment reference ${name} is unset; provide it and rebuild the runtime.`,
      );
    }
    return resolved;
  });
}

export function environmentReferences(value: unknown): string[] {
  if (typeof value === "string") {
    return [...value.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)].map((match) => match[1]!);
  }
  if (!value || typeof value !== "object") return [];
  return [...new Set(Object.values(value).flatMap(environmentReferences))];
}
