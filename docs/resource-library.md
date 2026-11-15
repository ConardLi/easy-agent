# Resource library

The desktop resource library manages installed skills, MCP servers, plugins,
hooks, rule files, and tools. Each resource shows the Agents that enable it in
the current workspace. Open its Agent menu to change one definition. The Agent
page offers the same choices, with inheritance and source details.

Installation, removal, plugin global enable/disable, MCP approval/reconnect,
hook editing, and global rule exclusions remain shared resource operations.
Selecting a resource for an Agent never approves an untrusted workspace or
overrides a global disable, permission rule, or managed policy. Managed hooks
cannot be removed by an Agent.

With no selection configured, Agents continue to use all available resources.
An `include` list restricts that kind to its entries; an empty list selects
nothing. `exclude` wins over `include`. A child's list replaces its parent's,
so changing an inherited choice copies the effective list into the child.
Changes to a parent can affect its descendants.

| Agent configuration | Identifiers |
| --- | --- |
| `skills.include` / `exclude` | Skill name, including plugin namespaces |
| `tools.include` / `exclude` | Tool name |
| `mcpServers.include` / `exclude` | Server name |
| `plugins.include` / `exclude` | Full plugin ID, such as `kit@market` |
| `hooks.include` / `exclude` | `selectionKey` from `runtime/inventory` |
| `rules.include` / `exclude` | Absolute rule file path, or `memory` |
| `hooks.enabled` | Boolean; false skips non-managed hooks |

These are Agent settings inside user-owned `harnesses`, classified as **agent**
configuration. No environment variables or new CLI flags are required.
Hook selection keys hash the source, event, matcher, command and shell, and do
not depend on array position or timeout. Identical hooks in the same source,
event and matcher share a choice. Changing a command creates a new resource.
Rule paths identify the local file; exported Agents may need paths adjusted on
another machine.

Selecting a plugin controls its skills, commands, sub-agents, output styles,
hooks, MCP and LSP servers. Prompt resources and execution lookups reflect the
Agent's current selection. MCP and LSP connection changes require restarting
the affected Agent processes; the library shows the pending restart. Installing
or removing extensions reloads every running Agent of the workspace.

The slash menu reads the conversation's Agent inventory, including before its
first session starts. It never falls back to another Agent's skills while that
inventory loads. A globally installed skill can therefore be selected for only
one Agent (give the others an empty or explicit `skills.include` list).

The library does not remove an exclusion wildcard to enable one matching
resource, since doing so could enable its siblings too. Adjust that Agent's
list explicitly in `~/.easy-agent/settings.json`, then reload the view.
Token counts and connection state use the reference Agent named in the library;
the conversation context panel shows request-specific usage.
