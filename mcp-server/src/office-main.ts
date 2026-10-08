import { accessVerifier, createOfficeService } from "./office.js";

const issuer = new URL(process.env.EASYSCHEMATIC_ACCESS_ISSUER ?? "");
const audience = process.env.EASYSCHEMATIC_ACCESS_AUDIENCE ?? "";
const origins = (process.env.EASYSCHEMATIC_OFFICE_EDITOR_ORIGINS ?? "https://testschematic.tateside.online").split(",").map(value => value.trim());
if (origins.some(origin => new URL(origin).origin !== origin || !origin.startsWith("https://"))) throw new Error("Office editor origins must be HTTPS origins.");
const port = Number(process.env.EASYSCHEMATIC_OFFICE_PORT ?? "8792");
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Invalid office service port.");
const office = createOfficeService(accessVerifier(issuer, audience), origins);
office.server.listen(port, "127.0.0.1", () => console.log(`EasySchematic office connector listening on loopback port ${port}.`));
process.on("SIGTERM", () => office.close());
process.on("SIGINT", () => office.close());
