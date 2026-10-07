import { useSchematicStore } from "../store";

export default function McpConnectionSettings() {
  const enabled = useSchematicStore((s) => s.mcpBridgeEnabled);
  const token = useSchematicStore((s) => s.mcpBridgeToken);
  const port = useSchematicStore((s) => s.mcpBridgePort);
  const status = useSchematicStore((s) => s.mcpBridgeStatus);
  const detail = useSchematicStore((s) => s.mcpBridgeStatusDetail);
  return <div className="space-y-3 text-xs">
    <p>Connect your local Codex or Claude MCP server to this open schematic. Enabled tools can read and edit devices, wiring, rooms, notes and racks.</p>
    <label className="flex flex-col gap-1">Pairing token
      <input aria-label="MCP pairing token" type="password" autoComplete="off" value={token} disabled={enabled}
        onChange={(e) => useSchematicStore.setState({ mcpBridgeToken: e.target.value })}
        className="border rounded p-2 bg-[var(--color-surface)]" />
    </label>
    <label className="flex flex-col gap-1">Local server port
      <input aria-label="MCP server port" type="number" min="1024" max="65535" value={port} disabled={enabled}
        onChange={(e) => useSchematicStore.setState({ mcpBridgePort: Number(e.target.value) })}
        className="border rounded p-2 bg-[var(--color-surface)]" />
    </label>
    <label className="flex items-center gap-2">
      <input type="checkbox" checked={enabled} disabled={!token.trim() || !Number.isInteger(port) || port < 1024 || port > 65535}
        onChange={(e) => useSchematicStore.setState({ mcpBridgeEnabled: e.target.checked })} />
      Let my AI assistant read and edit this schematic
    </label>
    <p role="status">Connection: {status}{detail ? ` — ${detail}` : ""}</p>
    <p className="text-[var(--color-text-muted)]">Allow local-network access if your browser asks. Use port 8765 for Codex or 8766 for Claude on this laptop.</p>
    <p className="text-[var(--color-text-muted)]">Pairing is session-only and turns off when this tab reloads. Missing devices can be created locally and used immediately. Publishing to the shared library still requires your approval in Library Doctor.</p>
  </div>;
}
