import { backup, DatabaseSync } from "node:sqlite";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const destination = path.join(root, ".tateside-data", "mcp-chatgpt-home", "research.db");
const incoming = `${destination}.incoming`;
const stamp = new Date().toISOString().replace(/[-:.]/g, "");
const remote = `/tmp/tateside-library-doctor-${stamp}.db`;
mkdirSync(path.dirname(destination), { recursive: true });
rmSync(incoming, { force: true });

try {
  execFileSync("ssh", ["easyschematic-vps", `rm -f ${remote}; cd /home/debian/EasySchematic-staging && sudo -u debian node dist-tateside-api/tateside-api/src/prepareMcpDevDb.js /var/lib/tateside-schematic-staging/tateside.db ${remote}`], { stdio: "inherit" });
  execFileSync("scp", [`easyschematic-vps:${remote}`, incoming], { stdio: "inherit" });
  const db = new DatabaseSync(incoming, { readOnly: true });
  const integrity = db.prepare("PRAGMA integrity_check").get().integrity_check;
  const deviceCount = db.prepare("SELECT COUNT(*) AS count FROM devices").get().count;
  const proposalCount = db.prepare("SELECT COUNT(*) AS count FROM library_doctor_proposals").get().count;
  db.close();
  if (integrity !== "ok") throw new Error("Downloaded research snapshot failed integrity check");
  let backupPath = null;
  if (existsSync(destination)) {
    backupPath = `${destination}.backup-${stamp}`;
    const previous = new DatabaseSync(destination, { readOnly: true });
    await backup(previous, backupPath);
    previous.close();
    rmSync(destination, { force: true });
  }
  renameSync(incoming, destination);
  console.log(JSON.stringify({ source: "TESTSCHEMATIC:/var/lib/tateside-schematic-staging/tateside.db", destination, backupPath, deviceCount, proposalCount, integrity }, null, 2));
} finally {
  rmSync(incoming, { force: true });
  try { execFileSync("ssh", ["easyschematic-vps", `rm -f ${remote}`]); } catch {}
}
