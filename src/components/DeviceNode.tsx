import { memo, useMemo, useCallback } from "react";
import type { NodeProps } from "@xyflow/react";
import type { DeviceNode as DeviceNodeType, Port } from "../types";
import { useSchematicStore } from "../store";
import { useDisplayLabel } from "../labelCaseUtils";
import { resolveDeviceLabel } from "../displayName";
import DeviceBlockVisual from "./DeviceBlockVisual";

function DeviceNodeComponent({ id, data, selected }: NodeProps<DeviceNodeType>) {
  const setEditingNodeId = useSchematicStore((s) => s.setEditingNodeId);
  const displayLabel = useDisplayLabel();
  const useShortNames = useSchematicStore((s) => s.useShortNames);
  const wrapDeviceLabels = useSchematicStore((s) => s.wrapDeviceLabels);
  const resolvedLabel = useMemo(
    () => resolveDeviceLabel(data, { useShortNames, wrapDeviceLabels }),
    [data, useShortNames, wrapDeviceLabels],
  );
  const hiddenPinSignalTypesStr = useSchematicStore((s) => s.hiddenPinSignalTypes);
  const isHiddenAdapter = useSchematicStore((s) => s.hiddenAdapterNodeIds.has(id));
  const isOverlapping = useSchematicStore((s) => s.overlapNodeId === id);
  const hiddenPinSignalTypes = useMemo(
    () => (hiddenPinSignalTypesStr ? new Set(hiddenPinSignalTypesStr.split(",")) : null),
    [hiddenPinSignalTypesStr],
  );
  const hideUnconnectedPorts = useSchematicStore((s) => s.hideUnconnectedPorts);
  const showPortCounts = useSchematicStore((s) => s.showPortCounts);
  const currency = useSchematicStore((s) => s.currency);
  const templateHiddenStr = useSchematicStore((s) => {
    if (!data.templateId) return "";
    const arr = s.templateHiddenSignals[data.templateId];
    return arr ? arr.sort().join(",") : "";
  });
  const connectedHandleStr = useSchematicStore((s) => {
    const ids: string[] = [];
    for (const e of s.edges) {
      if (e.source === id && e.sourceHandle) ids.push(e.sourceHandle);
      if (e.target === id && e.targetHandle) ids.push(e.targetHandle);
    }
    return ids.sort().join(",");
  });
  const connectedHandles = useMemo(
    () => new Set(connectedHandleStr ? connectedHandleStr.split(",") : []),
    [connectedHandleStr],
  );
  const connectedEdgeSignalsStr = useSchematicStore((s) => {
    const parts: string[] = [];
    for (const e of s.edges) {
      if (!e.data?.signalType) continue;
      if (e.source === id && e.sourceHandle) parts.push(`${e.sourceHandle}:${e.data.signalType}`);
      if (e.target === id && e.targetHandle) parts.push(`${e.targetHandle}:${e.data.signalType}`);
    }
    return parts.sort().join(",");
  });
  const signalByHandle = useMemo<Map<string, string>>(() => {
    const map = new Map<string, string>();
    if (!connectedEdgeSignalsStr) return map;
    for (const pair of connectedEdgeSignalsStr.split(",")) {
      const colon = pair.lastIndexOf(":");
      if (colon > 0) map.set(pair.slice(0, colon), pair.slice(colon + 1));
    }
    return map;
  }, [connectedEdgeSignalsStr]);
  const openPortMenu = useCallback((event: React.MouseEvent, port: Port) => {
    useSchematicStore.setState({
      portContextMenu: { nodeId: id, portId: port.id, screenX: event.clientX, screenY: event.clientY },
    });
  }, [id]);

  return (
    <DeviceBlockVisual
      data={data}
      resolvedLabel={resolvedLabel}
      displayLabel={displayLabel}
      selected={selected}
      hiddenPinSignalTypes={hiddenPinSignalTypes}
      isHiddenAdapter={isHiddenAdapter}
      isOverlapping={isOverlapping}
      hideUnconnectedPorts={hideUnconnectedPorts}
      showPortCounts={showPortCounts}
      currency={currency}
      templateHiddenStr={templateHiddenStr}
      connectedHandles={connectedHandles}
      signalByHandle={signalByHandle}
      onPortContextMenu={openPortMenu}
      onDoubleClick={() => setEditingNodeId(id)}
    />
  );
}

export default memo(DeviceNodeComponent);
