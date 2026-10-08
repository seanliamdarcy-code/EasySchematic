import { type ReactFlowInstance, getViewportForBounds } from "@xyflow/react";
import { toPng, toSvg } from "html-to-image";
import { useEffect } from "react";
import { useSchematicStore } from "./store";

const EXPORT_PADDING = 40;

interface ExportOptions {
  pixelRatio?: number;
  format?: "png" | "svg";
  backgroundColor?: string;
  maxDimension?: number;
}

let canvasInstance: ReactFlowInstance | undefined;
let captureInProgress = false;

export function useMcpCanvasCapture(instance: ReactFlowInstance) {
  useEffect(() => {
    canvasInstance = instance;
    return () => { if (canvasInstance === instance) canvasInstance = undefined; };
  }, [instance]);
}

export async function captureCanvas() {
  if (!canvasInstance) throw new Error("Schematic canvas is not mounted.");
  // Routing is scheduled 50ms after layout/Port measurements; capturing sooner
  // can show Devices and stub labels with their Connections still invisible.
  await new Promise(resolve => setTimeout(resolve, 100));
  const deadline = Date.now() + 5000;
  while (useSchematicStore.getState().isRouting) {
    if (Date.now() > deadline) throw new Error("Canvas routing is still running; retry after it finishes.");
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  if (!canvasInstance) throw new Error("Schematic canvas was closed.");
  const dataUrl = await renderImage(canvasInstance, { pixelRatio: 1, maxDimension: 1600 });
  if (!dataUrl) throw new Error("No Devices to capture.");
  const data = dataUrl.split(",")[1];
  if (!data || data.length > 8_000_000) throw new Error("Canvas image is too large.");
  return { data, mimeType: "image/png", scope: "Current schematic canvas; excludes print title block and other pages." };
}

export async function exportImage(instance: ReactFlowInstance, options: ExportOptions = {}) {
  const dataUrl = await renderImage(instance, options);
  if (!dataUrl) return;
  const link = document.createElement("a");
  link.download = `schematic.${options.format ?? "png"}`;
  link.href = dataUrl;
  link.click();
}

async function renderImage(
  reactFlowInstance: ReactFlowInstance,
  options: ExportOptions = {},
) {
  const {
    pixelRatio = 3,
    format = "png",
    backgroundColor = "#ffffff",
    maxDimension,
  } = options;

  const nodes = reactFlowInstance.getNodes();
  if (nodes.length === 0) return;

  let bounds = reactFlowInstance.getNodesBounds(nodes);
  if (maxDimension) {
    let left = bounds.x, top = bounds.y, right = bounds.x + bounds.width, bottom = bounds.y + bounds.height;
    for (const e of reactFlowInstance.getEdges()) for (const p of useSchematicStore.getState().routedEdges[e.id]?.waypoints ?? []) {
      left = Math.min(left, p.x); top = Math.min(top, p.y);
      right = Math.max(right, p.x); bottom = Math.max(bottom, p.y);
    }
    bounds = { x: left, y: top, width: right - left, height: bottom - top };
  }

  // Target dimensions with padding
  const fullWidth = bounds.width + EXPORT_PADDING * 2;
  const fullHeight = bounds.height + EXPORT_PADDING * 2;
  const reduction = maxDimension ? Math.min(1, maxDimension / Math.max(fullWidth, fullHeight)) : 1;
  const width = Math.ceil(fullWidth * reduction);
  const height = Math.ceil(fullHeight * reduction);

  // Compute viewport that fits all nodes into our export area
  const viewport = getViewportForBounds(bounds, width, height, maxDimension ? 0.0001 : 0.5, 2, maxDimension ? 0.1 : 0);

  const viewportEl = document.querySelector(
    ".react-flow__viewport",
  ) as HTMLElement;
  if (!viewportEl) return;
  if (captureInProgress) throw new Error("An image capture is already running; retry when it finishes.");
  captureInProgress = true;

  const toImage = format === "svg" ? toSvg : toPng;

  // Firefox returns `undefined` from getPropertyValue() for unrecognized CSS
  // properties, but html-to-image calls .trim() on the result without a null
  // check. Patch it to return '' instead while html-to-image runs.
  const origGetPropertyValue = CSSStyleDeclaration.prototype.getPropertyValue;
  CSSStyleDeclaration.prototype.getPropertyValue = function (prop) {
    return origGetPropertyValue.call(this, prop) ?? '';
  };

  // Force light-mode colors during capture — see [data-export-capturing] in index.css
  document.documentElement.setAttribute("data-export-capturing", "");
  // Let the style override flush before html-to-image reads computed styles
  let dataUrl: string;
  try {
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    dataUrl = await toImage(viewportEl, {
      backgroundColor,
      width,
      height,
      pixelRatio: format === "svg" ? 1 : pixelRatio,
      style: {
        width: `${width}px`,
        height: `${height}px`,
        transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})`,
      },
    });
  } finally {
    CSSStyleDeclaration.prototype.getPropertyValue = origGetPropertyValue;
    document.documentElement.removeAttribute("data-export-capturing");
    captureInProgress = false;
  }

  return dataUrl;
}
