import { useEffect, useRef, useState } from "react";
import { useSchematicStore } from "../store";

export default function McpConnectionSettings() {
  const enabled = useSchematicStore((s) => s.mcpBridgeEnabled);
  const token = useSchematicStore((s) => s.mcpBridgeToken);
  const port = useSchematicStore((s) => s.mcpBridgePort);
  const status = useSchematicStore((s) => s.mcpBridgeStatus);
  const detail = useSchematicStore((s) => s.mcpBridgeStatusDetail);
  const office = useSchematicStore((s) => s.mcpBridgeOffice);
  const popup = useRef<Window | null>(null);
  const [notice, setNotice] = useState("");
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.origin !== "https://schematic-mcp.tateside.online" || !popup.current || event.source !== popup.current
        || event.data?.type !== "easyschematic-office-paired") return;
      popup.current = null;
      useSchematicStore.setState({ mcpBridgeOffice: true, mcpBridgeEnabled: true });
      setNotice("");
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, []);
  return <div className="space-y-3 text-xs">
    <p>Connect your AI assistant to this editor. Give it a Jetbuilt P number to preview rooms and kit, choose a room, then build and wire its schematic.</p>
    <button type="button" className="border rounded p-2" disabled={enabled} onClick={() => {
      popup.current = window.open(`https://schematic-mcp.tateside.online/pair?origin=${encodeURIComponent(window.location.origin)}`, "easyschematic-office-pair", "popup,width=600,height=600");
      setNotice(popup.current ? "Complete office sign-in in the new window, then connect this schematic." : "Allow popups, then try again.");
    }}>Connect my office account</button>
    <p>Office connector URL: <code className="select-all">https://schematic-mcp.tateside.online/mcp</code>. Add it to Grok or another assistant that supports remote MCP, and sign in with the same office account.</p>
    {notice && <p role="status">{notice}</p>}
    <label className="flex items-center gap-2"><input type="checkbox" checked={office} disabled={enabled} onChange={(event) => useSchematicStore.setState({ mcpBridgeOffice: event.target.checked })} />Use the shared office connection</label>
    {!office && <>
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
    </>}
    <label className="flex items-center gap-2">
      <input type="checkbox" checked={enabled} disabled={!office && (!token.trim() || !Number.isInteger(port) || port < 1024 || port > 65535)}
        onChange={(e) => useSchematicStore.setState({ mcpBridgeEnabled: e.target.checked })} />
      Let my AI assistant read and edit this schematic
    </label>
    <p role="status">Connection: {status}{detail ? ` — ${detail}` : ""}</p>
    {!office && <p className="text-[var(--color-text-muted)]">Allow local-network access if your browser asks. Use port 8765 for Codex or 8766 for Claude on this laptop.</p>}
    <p className="text-[var(--color-text-muted)]">Pairing is session-only and turns off when this tab reloads. Missing devices can be researched and created locally immediately. Review a Device in Properties and choose Add to TateSide Library when you want to share it.</p>
  </div>;
}
