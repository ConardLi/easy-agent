# Headless output schema

`eagent --print --output-format json` emits one JSON object. `stream-json` emits newline-delimited JSON (NDJSON) messages.

## Versioning

Every JSON or NDJSON message includes:

```json
{"schema_version":1}
```

Schema version 1 is additive: existing fields are retained when optional fields are introduced. A future breaking rename, removal, type change, or semantic change requires a new `schema_version`. The machine-readable definition is [headless-output.schema.json](./headless-output.schema.json); CI validates actual CLI output against it.

### Migration from unversioned output

Earlier releases omitted `schema_version` and reported `total_cost_usd: 0` even though cost was not calculated. Treat those old zeros as unknown, not free usage. Version 1 retains all established fields and corrects cost to `number | null`. Consumers must accept added fields, check the schema version, and guard cost arithmetic with `typeof result.total_cost_usd === "number"`; do not coerce `null` to zero. JSON key ordering is not part of the contract.

## Result message

Both structured formats end with a `type: "result"` object. Its stable fields are:

- `schema_version`
- `type`, `subtype`, `is_error`, `result`
- `session_id`, `num_turns`, `duration_ms`
- `total_cost_usd`
- `usage`

`total_cost_usd` is `null` when cost accounting is unavailable. Consumers must distinguish `null` (unknown) from `0` (measured zero cost).

## Stream messages

After input and configuration initialization succeeds, `stream-json` starts with `type: "system", subtype: "init"`, may contain `assistant` and `user` messages, and ends with a `result` message on normal completion or a handled execution failure. Each line is independently parseable JSON and carries the same schema version.

Startup failures (for example unsupported Node, invalid CLI arguments or missing input) retain the established nonzero exit code and stderr-only diagnostic; a result message is not guaranteed before initialization or after a forced process termination. Exit code 0 indicates successful completion; execution failures return 1. `subtype` is `success`, `error_max_turns` or `error_during_execution`. Token counts in `usage` are accumulated runtime-reported usage, not a monetary estimate. A zero accumulated count on failure does not prove that an upstream service incurred no usage.
