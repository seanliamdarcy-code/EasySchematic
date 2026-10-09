// Keep pairing, message authentication and editor transport on the same deployment.
export function officeOrigin(value = "https://schematic-mcp.tateside.online"): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Office connector must be an HTTPS origin.");
  }
  return url.origin;
}

export const OFFICE_ORIGIN = officeOrigin(import.meta.env.VITE_EASYSCHEMATIC_OFFICE_ORIGIN);
export const OFFICE_EDITOR_URL = OFFICE_ORIGIN.replace(/^https:/, "wss:") + "/editor";
