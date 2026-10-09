import { useMemo } from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  type Node,
  type NodeProps,
  type NodeTypes,
} from "@xyflow/react";
import type { DeviceData } from "../types";
import DeviceBlockVisual from "./DeviceBlockVisual";

type PreviewNode = Node<{
  device: DeviceData;
  onOpen: () => void;
}, "proposal-preview">;

function PreviewNodeComponent({ data }: NodeProps<PreviewNode>) {
  return (
    <DeviceBlockVisual
      data={data.device}
      resolvedLabel={{ text: data.device.label, wrap: false }}
      onDoubleClick={data.onOpen}
    />
  );
}

const previewNodeTypes: NodeTypes = { "proposal-preview": PreviewNodeComponent };

export default function ProposalDeviceBlockPreview({
  proposalId,
  data,
  onOpen,
}: {
  proposalId: string;
  data: DeviceData;
  onOpen: () => void;
}) {
  const nodes = useMemo<PreviewNode[]>(() => [{
    id: `proposal-preview:${proposalId}`,
    type: "proposal-preview",
    position: { x: 0, y: 0 },
    data: { device: data, onOpen },
    draggable: false,
    connectable: false,
    selectable: false,
  }], [proposalId, data, onOpen]);

  return (
    <div
      className="h-[220px] w-full overflow-hidden rounded border border-[var(--color-border)] bg-[var(--color-bg)]"
      aria-label={`Read-only proposed device block for ${data.label}`}
      onDoubleClickCapture={onOpen}
      onContextMenu={(event) => event.preventDefault()}
    >
      <ReactFlowProvider>
        <ReactFlow
          nodes={nodes}
          edges={[]}
          nodeTypes={previewNodeTypes}
          fitView
          fitViewOptions={{ padding: 0.3, maxZoom: 1 }}
          minZoom={0.5}
          maxZoom={1}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          panOnDrag={false}
          zoomOnScroll={false}
          zoomOnPinch={false}
          zoomOnDoubleClick={false}
          preventScrolling={false}
          proOptions={{ hideAttribution: true }}
        />
      </ReactFlowProvider>
    </div>
  );
}
