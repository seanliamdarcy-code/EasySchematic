import { useSchematicStore } from "../store";
import { getPaperSize } from "../printConfig";
import { computePageGrid } from "../printPageGrid";
import { collectColorKeyEntries, layoutColorKey } from "../colorKeyLayout";
import { absRect } from "../snapUtils";
import { getPrintableArea } from "../printUtils";

export function sheetGeometry(s = useSchematicStore.getState()) {
  const paper = getPaperSize(s.printPaperId, s.printCustomWidthIn, s.printCustomHeightIn);
  const pages = computePageGrid(paper, s.printOrientation, s.printScale, s.nodes, s.titleBlockLayout.heightIn, s.printOriginOffsetX, s.printOriginOffsetY);
  const entries = s.colorKeyEnabled ? collectColorKeyEntries(s.edges, s.signalColors, s.signalLineStyles, s.colorKeyOverrides, s.colorKeyLabels) : [];
  const pt = 96 / s.printScale / 72;
  const legend = layoutColorKey(entries, s.colorKeyColumns, 77 * pt, 6.5 * pt * 1.8, 5 * pt, 7.5 * pt * 1.8);
  const reference = computePageGrid(paper, s.printOrientation, s.printScale, [{ id: "reference", position: { x: s.printOriginOffsetX + 100 / s.printScale, y: s.printOriginOffsetY + 100 / s.printScale }, measured: { width: 1, height: 1 } }], s.titleBlockLayout.heightIn, s.printOriginOffsetX, s.printOriginOffsetY)[0];
  const geometry = (p: typeof reference, i: number) => {
    const margin = p.contentX - p.x;
    const titleW = Math.min(s.titleBlockLayout.widthIn * 96 / s.printScale, p.contentW);
    const showLegend = entries.length > 0 && (s.colorKeyPage === "all" || (s.colorKeyPage === "first" ? i === 0 : i === pages.length - 1));
    return { page: i + 1, rect: { x: p.x, y: p.y, w: p.widthPx, h: p.heightPx },
      drawingArea: { x: p.contentX, y: p.contentY, w: p.contentW, h: p.contentH },
      titleBlock: { x: p.contentX + p.contentW - titleW, y: p.contentY + p.contentH, w: titleW, h: p.heightPx - 2 * margin - p.contentH },
      legend: showLegend ? { x: s.colorKeyCorner.includes("right") ? p.contentX + p.contentW - legend.width : p.contentX,
        y: s.colorKeyCorner.includes("bottom") ? p.y + p.heightPx - margin - legend.height : p.contentY, w: legend.width, h: legend.height } : null };
  };
  return { pageCount: pages.length, pages: pages.map(geometry), referencePage: geometry(reference, 0) };
}

export function fitSheet(s = useSchematicStore.getState()) {
  if (!s.nodes.length) throw new Error("No content to fit.");
  const map = new Map(s.nodes.map(n => [n.id, n]));
  const rects = s.nodes.map(n => absRect(n, map));
  let left = Math.min(...rects.map(r => r.left)), top = Math.min(...rects.map(r => r.top));
  let right = Math.max(...rects.map(r => r.right)), bottom = Math.max(...rects.map(r => r.bottom));
  for (const route of Object.values(s.routedEdges)) for (const p of route.waypoints) {
    left = Math.min(left, p.x); top = Math.min(top, p.y); right = Math.max(right, p.x); bottom = Math.max(bottom, p.y);
  }
  const paper = getPaperSize(s.printPaperId, s.printCustomWidthIn, s.printCustomHeightIn);
  const area = getPrintableArea(paper, s.printOrientation, s.titleBlockLayout.heightIn);
  const padding = 40;
  const requiredScale = Math.min((area.printableW * 96 - 2 * padding) / Math.max(1, right - left), (area.printableH * 96 - 2 * padding) / Math.max(1, bottom - top));
  const scale = Math.max(0.25, Math.min(2, requiredScale));
  const offset = { x: (left + right) / 2 - area.pageW * 96 / scale / 2,
    y: (top + bottom) / 2 - (area.pageH - s.titleBlockLayout.heightIn) * 96 / scale / 2 };
  return { scale, offset, fits: requiredScale >= 0.25, contentBounds: { x: left, y: top, w: right - left, h: bottom - top },
    overflow: { x: Math.max(0, right - left + 2 * padding / scale - area.printableW * 96 / scale), y: Math.max(0, bottom - top + 2 * padding / scale - area.printableH * 96 / scale) },
    note: "Fits content and routed Connections inside the drawing area; inspect print capture for legend collisions." };
}
