import { type ReactFlowInstance, getViewportForBounds } from "@xyflow/react";
import { toPng, toSvg } from "html-to-image";
import { createElement, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { useSchematicStore } from "./store";
import { sheetGeometry } from "./mcp/sheet";
import { PrintCaptureArtwork } from "./components/PageBoundaryOverlay";

const EXPORT_PADDING = 40;

interface ExportOptions {
  pixelRatio?: number;
  format?: "png" | "svg";
  backgroundColor?: string;
  maxDimension?: number;
  printPage?: number;
}

let canvasInstance: ReactFlowInstance | undefined;
let captureInProgress = false;

export function useMcpCanvasCapture(instance: ReactFlowInstance) {
  useEffect(() => {
    canvasInstance = instance;
    return () => { if (canvasInstance === instance) canvasInstance = undefined; };
  }, [instance]);
}

export async function captureCanvas(params: Record<string, unknown> = {}) {
  if (params.view !== undefined && params.view !== "canvas" && params.view !== "print") throw new Error("view must be canvas or print.");
  if (params.page !== undefined && (params.view !== "print" || typeof params.page !== "number" || !Number.isInteger(params.page) || params.page < 1)) throw new Error("page must be a positive, 1-based print page number.");
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
  const dataUrl = await renderImage(canvasInstance, { pixelRatio: 1, maxDimension: 1600, printPage: params.view === "print" ? (params.page as number ?? 1) : undefined });
  if (!dataUrl) throw new Error("No Devices to capture.");
  const data = dataUrl.split(",")[1];
  if (!data || data.length > 8_000_000) throw new Error("Canvas image is too large.");
  return { data, mimeType: "image/png", scope: params.view === "print" ? `Print view, page ${params.page ?? 1}; includes frame, title block, legend and page edges.` : "Current schematic canvas; excludes print title block and other pages." };
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
    printPage,
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
  const page = printPage === undefined ? undefined : sheetGeometry().pages[printPage - 1];
  if (printPage !== undefined && !page) throw new Error("Print page does not exist; read configure_sheet.pageCount.");
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
  let printContainer: HTMLDivElement | undefined;
  let printHost: HTMLDivElement | undefined;
  let artworkRoot: ReturnType<typeof createRoot> | undefined;
  try {
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    if (page) {
      const reduction = Math.min(1, 1600 / Math.max(page.rect.w, page.rect.h));
      const printWidth = Math.ceil(page.rect.w * reduction), printHeight = Math.ceil(page.rect.h * reduction);
      printContainer = document.createElement("div");
      printContainer.className = "react-flow";
      Object.assign(printContainer.style, { position: "relative", width: `${printWidth}px`, height: `${printHeight}px`, overflow: "hidden", background: "white" });
      printHost = document.createElement("div");
      Object.assign(printHost.style, { position: "fixed", left: "-100000px", top: "0" });
      printHost.append(printContainer);
      const clonedViewport = viewportEl.cloneNode(true) as HTMLElement;
      Object.assign(clonedViewport.style, { width: `${page.rect.w}px`, height: `${page.rect.h}px`, transform: `translate(${-page.rect.x * reduction}px, ${-page.rect.y * reduction}px) scale(${reduction})`, transformOrigin: "0 0" });
      printContainer.append(clonedViewport);
      const artwork = document.createElement("div");
      Object.assign(artwork.style, { position: "absolute", inset: "0", zIndex: "999" });
      printContainer.append(artwork);
      document.body.append(printHost);
      artworkRoot = createRoot(artwork);
      flushSync(() => artworkRoot!.render(createElement(PrintCaptureArtwork, { pageIndex: printPage! - 1, width: printWidth, height: printHeight, zoom: reduction })));
      dataUrl = await toPng(printContainer, { backgroundColor, width: printWidth, height: printHeight, pixelRatio: 1 });
    } else dataUrl = await toImage(viewportEl, {
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
    artworkRoot?.unmount();
    printHost?.remove();
    CSSStyleDeclaration.prototype.getPropertyValue = origGetPropertyValue;
    document.documentElement.removeAttribute("data-export-capturing");
    captureInProgress = false;
  }

  return dataUrl;
}
