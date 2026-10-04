/**
 * Interactive plugin and marketplace manager.
 *
 * The overlay keeps install, enablement, and marketplace source state visibly
 * separate while providing the keyboard flow users expect from Claude Code:
 * tabs, incremental search, detail inspection, explicit executable-code
 * confirmation, scoped actions, progress, and inline success/error feedback.
 */

import React from "react";
import { Box, Text, useInput } from "ink";
import type { PluginMutation, PluginViewData } from "../../core/queryEngine.js";
import type { PluginScope } from "../../plugins/schemas.js";
import type { PluginInstallPreview } from "../../plugins/install.js";
import { theme, glyph } from "../theme.js";
import { Spinner } from "./Spinner.js";

interface PluginManagerProps {
  data: PluginViewData;
  active: boolean;
  onMutate: (action: PluginMutation) => Promise<void>;
  onPreview: (pluginId: string) => Promise<PluginInstallPreview>;
  onClose: () => void;
}

type Tab = "discover" | "installed" | "marketplaces" | "errors";
type Mode = "list" | "search" | "details" | "addMarketplace" | "confirm";

interface PendingAction {
  action: PluginMutation;
  title: string;
  body: string;
  danger?: boolean;
}

const TABS: Tab[] = ["discover", "installed", "marketplaces", "errors"];
const SCOPES: PluginScope[] = ["user", "project", "local"];
const MAX_VISIBLE = 7;

function tabLabel(tab: Tab, data: PluginViewData): string {
  const label = tab[0]!.toUpperCase() + tab.slice(1);
  const count =
    tab === "discover"
      ? data.available.length
      : tab === "installed"
        ? data.installed.length
        : tab === "marketplaces"
          ? data.marketplaces.length
          : data.errors.length;
  return `${label} ${count}`;
}

function computeWindow(total: number, index: number): { start: number; end: number } {
  if (total <= MAX_VISIBLE) return { start: 0, end: total };
  const start = Math.max(0, Math.min(index - Math.floor(MAX_VISIBLE / 2), total - MAX_VISIBLE));
  return { start, end: start + MAX_VISIBLE };
}

function matches(query: string, ...values: Array<string | undefined>): boolean {
  if (!query) return true;
  const needle = query.toLowerCase();
  return values.some((value) => value?.toLowerCase().includes(needle));
}

function componentSummary(components: PluginViewData["installed"][number]["components"]): string {
  const parts: string[] = [];
  if (components.skills) parts.push(`${components.skills} skill`);
  if (components.agents) parts.push(`${components.agents} agent`);
  if (components.commands) parts.push(`${components.commands} command`);
  if (components.outputStyles) parts.push(`${components.outputStyles} style`);
  if (components.hooks) parts.push(`${components.hooks} hook`);
  if (components.mcpServers) parts.push(`${components.mcpServers} MCP`);
  if (components.lspServers) parts.push(`${components.lspServers} LSP`);
  return parts.join(" · ") || "No components detected";
}

function scopeLabel(scope: PluginScope): string {
  if (scope === "user") return "User";
  if (scope === "project") return "Project";
  return "Local";
}

function previewSummary(preview: PluginInstallPreview): string {
  const counts = [
    ["skills", preview.components.skills.length],
    ["agents", preview.components.agents.length],
    ["commands", preview.components.commands.length],
    ["styles", preview.components.outputStyles.length],
    ["hooks", preview.components.hooks.length],
    ["MCP servers", preview.components.mcpServers.length],
    ["LSP servers", preview.components.lspServers?.length ?? 0],
  ]
    .filter(([, count]) => Number(count) > 0)
    .map(([kind, count]) => `${count} ${kind}`)
    .join(" · ");
  return counts || "no components";
}

export function PluginManager({ data, active, onMutate, onPreview, onClose }: PluginManagerProps): React.ReactNode {
  const [tab, setTab] = React.useState<Tab>("installed");
  const [mode, setMode] = React.useState<Mode>("list");
  const [index, setIndex] = React.useState(0);
  const [scope, setScope] = React.useState<PluginScope>("user");
  const [query, setQuery] = React.useState("");
  const [buffer, setBuffer] = React.useState("");
  const [busy, setBusy] = React.useState<string | null>(null);
  const [failure, setFailure] = React.useState<string | null>(null);
  const [success, setSuccess] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState<PendingAction | null>(null);

  const available = data.available.filter((row) =>
    matches(query, row.pluginId, row.name, row.marketplace, row.description),
  );
  const installed = data.installed.filter((row) =>
    matches(query, row.pluginId, row.name, row.marketplace, row.description, row.author),
  );
  const marketplaces = data.marketplaces.filter((row) => matches(query, row.name, row.kind, row.location));
  const errors = data.errors.filter((row) => matches(query, row.pluginId, row.scope, row.message));

  const total =
    tab === "discover"
      ? available.length
      : tab === "installed"
        ? installed.length
        : tab === "marketplaces"
          ? marketplaces.length + 1
          : errors.length;
  const selectedIndex = total === 0 ? 0 : Math.min(index, total - 1);
  const selectedAvailable = tab === "discover" ? available[selectedIndex] : undefined;
  const selectedInstalled = tab === "installed" ? installed[selectedIndex] : undefined;
  const selectedMarketplace = tab === "marketplaces" && selectedIndex > 0 ? marketplaces[selectedIndex - 1] : undefined;
  const selectedError = tab === "errors" ? errors[selectedIndex] : undefined;

  React.useEffect(() => {
    if (index >= total) setIndex(Math.max(0, total - 1));
  }, [index, total]);

  const run = React.useCallback(
    (action: PluginMutation, label: string) => {
      setBusy(label);
      setFailure(null);
      setSuccess(null);
      void onMutate(action)
        .then(() => {
          setBusy(null);
          setSuccess(`${label} complete`);
        })
        .catch((error: unknown) => {
          setBusy(null);
          setFailure(error instanceof Error ? error.message : String(error));
        });
    },
    [onMutate],
  );

  const ask = React.useCallback((next: PendingAction) => {
    setPending(next);
    setMode("confirm");
    setFailure(null);
  }, []);

  const askInstall = React.useCallback(() => {
    if (!selectedAvailable) return;
    setBusy(`Inspecting ${selectedAvailable.pluginId}`);
    setFailure(null);
    void onPreview(selectedAvailable.pluginId)
      .then((preview) => {
        setBusy(null);
        if (preview.errors.length > 0) {
          throw new Error(`Plugin validation failed: ${preview.errors.join("; ")}`);
        }
        ask({
          action: {
            op: "install",
            pluginId: selectedAvailable.pluginId,
            scope,
            confirmedExecutableComponents: true,
            expectedFingerprint: preview.fingerprint,
          },
          title: `Install ${selectedAvailable.pluginId} v${preview.version}?`,
          body:
            `Scope: ${scopeLabel(scope)} · ${previewSummary(preview)}. ` +
            (preview.hasExecutableComponents
              ? "⚠ Hooks/MCP/LSP may execute local processes."
              : "No executable Hooks, MCP, or LSP servers detected."),
          danger: preview.hasExecutableComponents,
        });
      })
      .catch((error: unknown) => {
        setBusy(null);
        setFailure(error instanceof Error ? error.message : String(error));
      });
  }, [ask, onPreview, scope, selectedAvailable]);

  const askUpdate = React.useCallback(() => {
    if (!selectedInstalled) return;
    const actionScope = selectedInstalled.scope ?? scope;
    setBusy(`Inspecting update for ${selectedInstalled.pluginId}`);
    setFailure(null);
    void onPreview(selectedInstalled.pluginId)
      .then((preview) => {
        setBusy(null);
        if (preview.errors.length > 0) {
          throw new Error(`Plugin validation failed: ${preview.errors.join("; ")}`);
        }
        ask({
          action: {
            op: "update",
            pluginId: selectedInstalled.pluginId,
            scope: actionScope,
            confirmedExecutableComponents: true,
            expectedFingerprint: preview.fingerprint,
          },
          title: `Update ${selectedInstalled.pluginId} to v${preview.version}?`,
          body:
            `Current: v${selectedInstalled.version} · Incoming: ${previewSummary(preview)}. ` +
            (preview.hasExecutableComponents
              ? "⚠ Hooks/MCP may execute local processes."
              : "No executable Hooks or MCP servers detected.") +
            " The current version is restored if validation or activation fails.",
          danger: preview.hasExecutableComponents,
        });
      })
      .catch((error: unknown) => {
        setBusy(null);
        setFailure(error instanceof Error ? error.message : String(error));
      });
  }, [ask, onPreview, scope, selectedInstalled]);

  useInput(
    (input, key) => {
      if (!active) return;
      if (busy) return;

      if (mode === "search" || mode === "addMarketplace") {
        if (key.escape) {
          if (mode === "search") setQuery("");
          setBuffer("");
          setMode("list");
          return;
        }
        if (key.return) {
          if (mode === "search") {
            setQuery(buffer.trim());
          } else if (buffer.trim()) {
            run({ op: "marketplace-add", source: buffer.trim() }, `Added marketplace ${buffer.trim()}`);
          }
          setBuffer("");
          setIndex(0);
          setMode("list");
          return;
        }
        if (key.backspace || key.delete) {
          setBuffer((value) => value.slice(0, -1));
          return;
        }
        if (input && !key.ctrl && !key.meta) setBuffer((value) => value + input);
        return;
      }

      if (mode === "confirm") {
        if ((input === "y" || key.return) && pending) {
          const label = pending.title.replace(/\?$/, "");
          run(pending.action, label);
          setPending(null);
          setMode("list");
        } else if (input === "n" || key.escape) {
          setPending(null);
          setMode("list");
        }
        return;
      }

      if (mode === "details") {
        if (key.escape || key.leftArrow || input === "i") {
          setMode("list");
          return;
        }
        if (selectedAvailable && (key.return || input === "a")) askInstall();
        if (selectedInstalled && input === "u") askUpdate();
        return;
      }

      if (key.escape) {
        onClose();
        return;
      }
      if (key.tab || key.rightArrow) {
        setTab(TABS[(TABS.indexOf(tab) + 1) % TABS.length]!);
        setIndex(0);
        setFailure(null);
        return;
      }
      if (key.leftArrow) {
        setTab(TABS[(TABS.indexOf(tab) - 1 + TABS.length) % TABS.length]!);
        setIndex(0);
        setFailure(null);
        return;
      }
      if (key.upArrow && total > 0) {
        setIndex((value) => (Math.min(value, total - 1) - 1 + total) % total);
        return;
      }
      if (key.downArrow && total > 0) {
        setIndex((value) => (Math.min(value, total - 1) + 1) % total);
        return;
      }
      if (input === "/") {
        setBuffer(query);
        setMode("search");
        return;
      }
      if (input === "s") {
        setScope((value) => SCOPES[(SCOPES.indexOf(value) + 1) % SCOPES.length]!);
        return;
      }
      if (input === "r") {
        run({ op: "reload" }, "Reloaded plugins");
        return;
      }
      if (input === "i" || (key.return && tab !== "marketplaces")) {
        if (total > 0) setMode("details");
        return;
      }

      if (selectedAvailable && input === "a") {
        askInstall();
        return;
      }
      if (selectedInstalled) {
        if (input === " " || input === "e") {
          run(
            {
              op: selectedInstalled.enabled ? "disable" : "enable",
              pluginId: selectedInstalled.pluginId,
              scope: selectedInstalled.enabled ? (selectedInstalled.scope ?? scope) : scope,
            },
            `${selectedInstalled.enabled ? "Disabled" : "Enabled"} ${selectedInstalled.pluginId}`,
          );
          return;
        }
        if (input === "u") {
          askUpdate();
          return;
        }
        if (input === "x") {
          ask({
            action: {
              op: "uninstall",
              pluginId: selectedInstalled.pluginId,
              scope: selectedInstalled.scope ?? scope,
            },
            title: `Uninstall ${selectedInstalled.pluginId}?`,
            body: "The managed plugin version and its persistent plugin data will be removed.",
            danger: true,
          });
          return;
        }
      }

      if (tab === "marketplaces") {
        if (selectedIndex === 0 && key.return) {
          setBuffer("");
          setMode("addMarketplace");
        } else if (selectedMarketplace && (key.return || input === "u")) {
          run({ op: "marketplace-update", name: selectedMarketplace.name }, `Refreshed ${selectedMarketplace.name}`);
        } else if (selectedMarketplace && input === "x") {
          ask({
            action: { op: "marketplace-remove", name: selectedMarketplace.name },
            title: `Remove ${selectedMarketplace.name}?`,
            body:
              selectedMarketplace.kind === "local"
                ? "Only the registration is removed; your local directory is never deleted."
                : "The managed Git checkout is removed. Installed plugin versions remain cached.",
            danger: true,
          });
        }
      }
    },
    { isActive: active },
  );

  if (mode === "search" || mode === "addMarketplace") {
    const adding = mode === "addMarketplace";
    return (
      <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor={theme.borderDim} paddingX={1}>
        <Text color={theme.brand} bold>
          {adding ? "Add marketplace" : `Search ${tab}`}
        </Text>
        <Box>
          <Text color={theme.muted}>{adding ? "Source  " : "Filter  "}</Text>
          <Text color={theme.brand}>{buffer}</Text>
          <Text color={theme.brand}>█</Text>
        </Box>
        <Text color={theme.muted} dimColor>
          {adding ? "owner/repo · Git URL · local directory" : "Enter apply · Esc clear and return"}
        </Text>
      </Box>
    );
  }

  if (mode === "confirm" && pending) {
    return (
      <Box
        flexDirection="column"
        marginTop={1}
        borderStyle="round"
        borderColor={pending.danger ? theme.warn : theme.border}
        paddingX={1}
      >
        <Text color={pending.danger ? theme.warn : theme.brand} bold>
          {pending.danger ? "⚠ " : ""}
          {pending.title}
        </Text>
        <Text>{pending.body}</Text>
        <Text color={theme.muted}>Enter/y confirm · n/Esc cancel</Text>
      </Box>
    );
  }

  if (mode === "details") {
    return (
      <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor={theme.borderDim} paddingX={1}>
        <Text color={theme.brand} bold>
          {selectedInstalled?.pluginId ?? selectedAvailable?.pluginId ?? selectedError?.pluginId ?? "Plugin details"}
        </Text>
        {selectedInstalled ? (
          <>
            <Text color={theme.muted}>
              v{selectedInstalled.version} · {selectedInstalled.marketplace} ·{" "}
              {selectedInstalled.enabled ? `enabled (${selectedInstalled.scope ?? "inherited"})` : "disabled"}
            </Text>
            {selectedInstalled.description ? <Text>{selectedInstalled.description}</Text> : null}
            {selectedInstalled.author ? <Text color={theme.muted}>Author: {selectedInstalled.author}</Text> : null}
            <Text>{componentSummary(selectedInstalled.components)}</Text>
            {Object.entries(selectedInstalled.componentNames).map(([kind, names]) =>
              names.length > 0 ? (
                <Text key={kind} color={theme.muted} wrap="wrap">
                  {kind}: {names.join(", ")}
                </Text>
              ) : null,
            )}
            {selectedInstalled.hasExecutableComponents ? (
              <Text color={theme.warn}>
                ⚠ Includes executable Hooks/MCP
                {!selectedInstalled.executablesTrusted ? " · blocked until project is trusted" : ""}
              </Text>
            ) : null}
            {selectedInstalled.warnings.map((warning, warningIndex) => (
              <Text key={warningIndex} color={theme.warn}>
                warning: {warning}
              </Text>
            ))}
            <Text color={theme.muted}>u update · i/Esc back</Text>
          </>
        ) : selectedAvailable ? (
          <>
            <Text color={theme.muted}>
              {selectedAvailable.version ? `v${selectedAvailable.version} · ` : ""}
              {selectedAvailable.marketplace}
            </Text>
            <Text>{selectedAvailable.description ?? "No description provided."}</Text>
            <Text color={theme.warn}>
              Install contents are validated before activation; executable components require confirmation.
            </Text>
            <Text color={theme.muted}>Enter/a install · i/Esc back</Text>
          </>
        ) : selectedError ? (
          <>
            <Text color={theme.error}>
              [{selectedError.scope}] {selectedError.message}
            </Text>
            <Text color={theme.muted}>Run /doctor for the complete diagnostic report · i/Esc back</Text>
          </>
        ) : null}
      </Box>
    );
  }

  const { start, end } = computeWindow(total, selectedIndex);

  return (
    <Box flexDirection="column" marginTop={1}>
      <Box>
        <Text color={theme.info}>{glyph.toolDot} </Text>
        <Text color={theme.info} bold>
          Plugins
        </Text>
        <Text color={theme.muted}>
          {"  "}
          {scopeLabel(scope)} scope{data.projectTrusted ? "" : " · project untrusted"}
        </Text>
      </Box>

      <Box marginLeft={2}>
        {TABS.map((item) => (
          <Text key={item} color={item === tab ? theme.brand : theme.muted} bold={item === tab}>
            {item === tab ? `▸ ${tabLabel(item, data)}  ` : `  ${tabLabel(item, data)}  `}
          </Text>
        ))}
      </Box>

      {query ? (
        <Box marginLeft={2}>
          <Text color={theme.info}>filter: “{query}”</Text>
          <Text color={theme.muted}> · / edit · Esc close</Text>
        </Box>
      ) : null}
      {start > 0 ? (
        <Text color={theme.muted}>
          {"  ↑ "}
          {start} more
        </Text>
      ) : null}

      {total === 0 ? (
        <Box marginLeft={2} paddingY={1}>
          <Text color={theme.muted}>
            {query
              ? "No matches. Press / to change the filter."
              : tab === "discover"
                ? data.marketplaces.length === 0
                  ? "No marketplaces yet. Open Marketplaces to add one."
                  : "All catalogued plugins are installed."
                : tab === "installed"
                  ? "No plugins installed. Browse Discover to get started."
                  : "No plugin errors."}
          </Text>
        </Box>
      ) : null}

      {tab === "discover"
        ? available.slice(start, end).map((row, offset) => {
            const selected = start + offset === selectedIndex;
            return (
              <Box key={row.pluginId}>
                <Text color={selected ? theme.brand : undefined} bold={selected}>
                  {selected ? "› " : "  "}
                  {row.pluginId}
                </Text>
                {row.version ? (
                  <Text color={theme.muted}>
                    {"  v"}
                    {row.version}
                  </Text>
                ) : null}
                {row.description ? (
                  <Text color={theme.muted} wrap="truncate-end">
                    {"  "}
                    {row.description}
                  </Text>
                ) : null}
              </Box>
            );
          })
        : null}

      {tab === "installed"
        ? installed.slice(start, end).map((row, offset) => {
            const selected = start + offset === selectedIndex;
            return (
              <Box key={row.pluginId}>
                <Text color={row.enabled ? theme.ok : theme.muted}>
                  {selected ? "› " : "  "}
                  {row.enabled ? "● " : "○ "}
                </Text>
                <Text color={selected ? theme.brand : undefined} bold={selected}>
                  {row.pluginId}
                </Text>
                <Text color={theme.muted}>
                  {"  "}v{row.version}
                  {row.scope ? ` · ${row.scope}` : ""}
                </Text>
                {row.hasExecutableComponents ? <Text color={theme.warn}>{"  ⚡"}</Text> : null}
                {row.errorCount ? (
                  <Text color={theme.error}>
                    {"  "}
                    {row.errorCount} issue
                  </Text>
                ) : null}
              </Box>
            );
          })
        : null}

      {tab === "marketplaces" ? (
        <>
          {start === 0 ? (
            <Text color={selectedIndex === 0 ? theme.brand : theme.muted} bold={selectedIndex === 0}>
              {selectedIndex === 0 ? "› " : "  "}⊕ Add marketplace…
            </Text>
          ) : null}
          {marketplaces.slice(Math.max(0, start - 1), Math.max(0, end - 1)).map((row, offset) => {
            const rowIndex = Math.max(0, start - 1) + offset + 1;
            const selected = rowIndex === selectedIndex;
            return (
              <Box key={row.name}>
                <Text color={selected ? theme.brand : undefined} bold={selected}>
                  {selected ? "› " : "  "}
                  {row.name}
                </Text>
                <Text color={theme.muted}>
                  {"  "}
                  {row.kind} · {row.pluginCount ?? "?"} plugin(s)
                </Text>
                {row.error ? <Text color={theme.error}>{"  unreadable"}</Text> : null}
              </Box>
            );
          })}
        </>
      ) : null}

      {tab === "errors"
        ? errors.slice(start, end).map((row, offset) => {
            const selected = start + offset === selectedIndex;
            return (
              <Box key={`${row.pluginId}:${row.scope}:${offset}`}>
                <Text color={selected ? theme.brand : theme.error} bold={selected}>
                  {selected ? "› " : "  "}
                  {row.pluginId}
                </Text>
                <Text color={theme.muted}>
                  {"  ["}
                  {row.scope}
                  {"] "}
                </Text>
                <Text color={theme.muted} wrap="truncate-end">
                  {row.message}
                </Text>
              </Box>
            );
          })
        : null}

      {total - end > 0 ? (
        <Text color={theme.muted}>
          {"  ↓ "}
          {total - end} more
        </Text>
      ) : null}

      {busy ? (
        <Box marginLeft={2} marginTop={1}>
          <Spinner label={busy} showHint={false} />
        </Box>
      ) : null}
      {success ? (
        <Text color={theme.ok}>
          {"  ✓ "}
          {success}
        </Text>
      ) : null}
      {failure ? (
        <Text color={theme.error} wrap="wrap">
          {"  ✗ "}
          {failure}
        </Text>
      ) : null}

      <Box marginLeft={2} marginTop={1}>
        <Text color={theme.muted}>
          ↑↓ navigate · Enter/i details · / search · s scope · r reload · Tab switch · Esc close
        </Text>
      </Box>
      <Box marginLeft={2}>
        <Text color={theme.muted} dimColor>
          {tab === "discover"
            ? "a install"
            : tab === "installed"
              ? "Space/e enable · u update · x uninstall"
              : tab === "marketplaces"
                ? "Enter refresh/add · x remove"
                : "Enter inspect"}
        </Text>
      </Box>
    </Box>
  );
}
