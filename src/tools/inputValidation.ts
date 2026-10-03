import { Ajv, type ErrorObject, type ValidateFunction } from "ajv";
import { Ajv2019 } from "ajv/dist/2019.js";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { Tool } from "./Tool.js";
import { logWarn } from "../utils/log.js";

const MAX_INPUT_BYTES = 8 * 1024 * 1024;
const MAX_INPUT_NODES = 100_000;
const MAX_SCHEMA_BYTES = 4 * 1024 * 1024;
const MAX_SCHEMA_NODES = 50_000;
const MAX_DEPTH = 64;
const RESERVED_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const ajvOptions = {
  allErrors: true,
  strict: false,
  validateFormats: false,
  coerceTypes: false,
  removeAdditional: false,
  useDefaults: false,
  ownProperties: true,
} as const;
interface CompiledSchema {
  schema: Tool["inputSchema"];
  validate?: ValidateFunction;
}

const compiledSchemas = new WeakMap<Tool, CompiledSchema>();

function fieldPath(base: string, name: string): string {
  const segment = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? `.${name}` : `[${JSON.stringify(name.slice(0, 60))}]`;
  return `${base}${segment}`.slice(0, 200);
}

function inspectJson(value: unknown, maxBytes: number, maxNodes: number): string | undefined {
  const seen = new WeakSet<object>();
  const stack: Array<{ value: unknown; path: string; depth: number }> = [{ value, path: "$", depth: 0 }];
  let bytes = 0;
  let nodes = 0;

  while (stack.length > 0) {
    const item = stack.pop()!;
    if (++nodes > maxNodes) return "too many values";
    if (item.depth > MAX_DEPTH) return `${item.path} is too deeply nested`;
    const current = item.value;
    if (current === null || typeof current === "boolean") continue;
    if (typeof current === "string") {
      bytes += Buffer.byteLength(current);
    } else if (typeof current === "number") {
      if (!Number.isFinite(current)) return `${item.path} must be a finite number`;
      bytes += 8;
    } else if (typeof current === "object") {
      if (seen.has(current)) return `${item.path} contains a circular or shared reference`;
      seen.add(current);
      if (Array.isArray(current)) {
        if (current.length > maxNodes - nodes) return "too many values";
        const keys = Reflect.ownKeys(current);
        if (keys.length !== current.length + 1) return `${item.path} must be a JSON array`;
        for (let index = current.length - 1; index >= 0; index--) {
          const descriptor = Object.getOwnPropertyDescriptor(current, index);
          if (!descriptor || !("value" in descriptor)) return `${item.path}[${index}] must be a JSON value`;
          stack.push({ value: descriptor.value, path: `${item.path}[${index}]`.slice(0, 200), depth: item.depth + 1 });
        }
      } else {
        const prototype = Object.getPrototypeOf(current);
        if (prototype !== Object.prototype && prototype !== null) return `${item.path} must be a plain object`;
        const keys = Reflect.ownKeys(current);
        if (keys.length > maxNodes - nodes) return "too many values";
        for (const key of keys) {
          if (typeof key !== "string") return `${item.path} must contain string keys only`;
          const path = fieldPath(item.path, key);
          if (RESERVED_KEYS.has(key)) return `${path} is a reserved field`;
          bytes += Buffer.byteLength(key);
          const descriptor = Object.getOwnPropertyDescriptor(current, key);
          if (!descriptor || !("value" in descriptor)) return `${path} must be a JSON value`;
          stack.push({ value: descriptor.value, path, depth: item.depth + 1 });
        }
      }
    } else {
      return `${item.path} must be a JSON value`;
    }
    if (bytes > maxBytes) return `exceeds the ${Math.floor(maxBytes / 1024 / 1024)} MiB limit`;
  }
  return undefined;
}

function compileSchema(tool: Tool): CompiledSchema {
  const cached = compiledSchemas.get(tool);
  if (cached?.schema === tool.inputSchema) return cached;
  const compiled: CompiledSchema = { schema: tool.inputSchema };
  compiledSchemas.set(tool, compiled);
  const schema = tool.inputSchema as unknown;
  let schemaError: string | undefined;
  try {
    schemaError = inspectJson(schema, MAX_SCHEMA_BYTES, MAX_SCHEMA_NODES);
  } catch {
    schemaError = "invalid schema";
  }
  if (!schema || typeof schema !== "object" || Array.isArray(schema) || schemaError) {
    logWarn(`Tool '${tool.name}' has an invalid input schema and is unavailable`);
    return compiled;
  }
  try {
    const dialect = (schema as { $schema?: unknown }).$schema;
    const Validator =
      typeof dialect === "string" && dialect.includes("2020-12")
        ? Ajv2020
        : typeof dialect === "string" && dialect.includes("2019-09")
          ? Ajv2019
          : Ajv;
    const ajv = new Validator(ajvOptions);
    const validate = ajv.compile(schema);
    compiled.validate = (validate as ValidateFunction & { $async?: boolean }).$async ? undefined : validate;
  } catch {
    compiled.validate = undefined;
  }
  if (!compiled.validate) logWarn(`Tool '${tool.name}' has an invalid input schema and is unavailable`);
  return compiled;
}

export function hasValidToolInputSchema(tool: Tool): boolean {
  return compileSchema(tool).validate !== undefined;
}

function pointerPath(pointer: string): string {
  if (!pointer) return "$";
  return pointer
    .split("/")
    .slice(1)
    .reduce((path, token) => {
      const part = token.replace(/~1/g, "/").replace(/~0/g, "~");
      return /^\d+$/.test(part) ? `${path}[${part}]`.slice(0, 200) : fieldPath(path, part);
    }, "$");
}

function describeError(error: ErrorObject): string {
  const parameters = error.params as Record<string, unknown>;
  const base = pointerPath(error.instancePath);
  if (error.keyword === "required" && typeof parameters.missingProperty === "string") {
    return `${fieldPath(base, parameters.missingProperty)} is required`;
  }
  if (error.keyword === "additionalProperties" && typeof parameters.additionalProperty === "string") {
    return `${fieldPath(base, parameters.additionalProperty)} is not allowed`;
  }
  if (error.keyword === "type" && typeof parameters.type === "string") {
    return `${base} must be ${parameters.type}`;
  }
  const descriptions: Record<string, string> = {
    enum: "must be an allowed value",
    const: "must match the required value",
    minimum: "is below the minimum",
    exclusiveMinimum: "is below the minimum",
    maximum: "is above the maximum",
    exclusiveMaximum: "is above the maximum",
    minLength: "is too short",
    maxLength: "is too long",
    minItems: "has too few items",
    maxItems: "has too many items",
    pattern: "does not match the required pattern",
  };
  return `${base} ${descriptions[error.keyword] ?? "does not match the tool schema"}`;
}

export type ToolInputValidation =
  | { ok: true; input: Record<string, unknown> }
  | { ok: false; message: string; input?: Record<string, unknown> };

export function validateToolInput(tool: Tool, input: unknown): ToolInputValidation {
  const compiled = compileSchema(tool);
  if (!compiled.validate) return { ok: false, message: "tool input schema is invalid" };
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, message: "$ must be an object" };
  }
  let structuralError: string | undefined;
  try {
    structuralError = inspectJson(input, MAX_INPUT_BYTES, MAX_INPUT_NODES);
  } catch {
    structuralError = "$ must be a JSON object";
  }
  if (structuralError) return { ok: false, message: structuralError };
  if (compiled.validate(input)) return { ok: true, input: input as Record<string, unknown> };
  const errors = (compiled.validate.errors ?? []).slice(0, 3).map(describeError);
  return {
    ok: false,
    message: errors.join("; ") || "$ does not match the tool schema",
    input: input as Record<string, unknown>,
  };
}
