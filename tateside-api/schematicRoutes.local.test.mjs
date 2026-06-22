import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

const accessEmail = "route-test@example.com";

function makeSchematic(name, extra = {}) {
  return {
    version: 1,
    name,
    nodes: [],
    edges: [],
    ...extra,
  };
}

function requestHeaders() {
  return {
    "Content-Type": "application/json",
    "Cf-Access-Authenticated-User-Email": accessEmail,
  };
}

async function getAvailablePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to allocate a localhost port")));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

async function waitForHealth(baseUrl) {
  const healthUrl = new URL("/health", baseUrl);
  const deadline = Date.now() + 10_000;
  let lastError = null;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(healthUrl, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) {
        return;
      }
      lastError = new Error(`/health returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw lastError instanceof Error ? lastError : new Error("Timed out waiting for TateSide API health check");
}

async function startServer() {
  const root = mkdtempSync(path.join(os.tmpdir(), "tateside-api-routes-"));
  const port = await getAvailablePort();
  const child = spawn(
    process.execPath,
    ["dist-tateside-api/tateside-api/src/server.js"],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        TATESIDE_DATA_DIR: root,
        TATESIDE_API_HOST: "127.0.0.1",
        TATESIDE_API_PORT: String(port),
        TATESIDE_REQUIRE_ACCESS_IDENTITY: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  try {
    await waitForHealth(`http://127.0.0.1:${port}`);
  } catch (error) {
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));
    rmSync(root, { recursive: true, force: true });
    throw new Error(
      `Failed to start TateSide API route test server: ${error instanceof Error ? error.message : String(error)}\n${stdout}${stderr}`,
    );
  }

  return {
    baseUrl: new URL(`http://127.0.0.1:${port}`),
    async stop() {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
      rmSync(root, { recursive: true, force: true });
    },
  };
}

async function readJson(response) {
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

test("schematic routes cover create, save, versions, restore, and validation", async () => {
  const server = await startServer();

  try {
    const listUrl = new URL("/api/tateside/schematics", server.baseUrl);
    const createResponse = await fetch(listUrl, {
      method: "POST",
      headers: requestHeaders(),
      body: JSON.stringify({
        data: makeSchematic("Alpha", {
          metadata: { revision: 1 },
        }),
        source: "route-test-create",
      }),
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(createResponse.status, 201);
    const created = await readJson(createResponse);
    assert.match(created.schematic.id, /^sch_[a-f0-9]{32}$/);
    assert.equal(created.schematic.createdByEmail, accessEmail);
    assert.equal(created.version.source, "route-test-create");
    assert.equal(created.data.name, "Alpha");

    const listResponse = await fetch(listUrl, {
      headers: {
        "Cf-Access-Authenticated-User-Email": accessEmail,
      },
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(listResponse.status, 200);
    const listed = await readJson(listResponse);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].id, created.schematic.id);

    const schematicUrl = new URL(`/api/tateside/schematics/${created.schematic.id}`, server.baseUrl);
    const currentResponse = await fetch(schematicUrl, {
      headers: {
        "Cf-Access-Authenticated-User-Email": accessEmail,
      },
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(currentResponse.status, 200);
    const current = await readJson(currentResponse);
    assert.equal(current.version.sequence, 1);
    assert.equal(current.data.name, "Alpha");

    const dedupeResponse = await fetch(schematicUrl, {
      method: "PUT",
      headers: requestHeaders(),
      body: JSON.stringify({
        data: {
          edges: [],
          metadata: { revision: 1 },
          name: "Alpha",
          nodes: [],
          version: 1,
        },
        source: "route-test-save-noop",
      }),
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(dedupeResponse.status, 200);
    const deduped = await readJson(dedupeResponse);
    assert.equal(deduped.createdNewVersion, false);
    assert.equal(deduped.schematic.currentVersionSequence, 1);
    assert.equal(deduped.schematic.updatedByEmail, accessEmail);

    const changedResponse = await fetch(schematicUrl, {
      method: "PUT",
      headers: requestHeaders(),
      body: JSON.stringify({
        data: makeSchematic("Alpha v2", {
          metadata: { revision: 2 },
        }),
        source: "route-test-save-changed",
      }),
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(changedResponse.status, 200);
    const changed = await readJson(changedResponse);
    assert.equal(changed.createdNewVersion, true);
    assert.equal(changed.version.sequence, 2);
    assert.equal(changed.version.source, "route-test-save-changed");
    assert.equal(changed.data.name, "Alpha v2");

    const versionsUrl = new URL(`/api/tateside/schematics/${created.schematic.id}/versions`, server.baseUrl);
    const versionsResponse = await fetch(versionsUrl, {
      headers: {
        "Cf-Access-Authenticated-User-Email": accessEmail,
      },
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(versionsResponse.status, 200);
    const versions = await readJson(versionsResponse);
    assert.deepEqual(
      versions.versions.map((version) => [version.sequence, version.isCurrent]),
      [[2, true], [1, false]],
    );

    const versionUrl = new URL(`/api/tateside/schematics/${created.schematic.id}/versions/1`, server.baseUrl);
    const versionResponse = await fetch(versionUrl, {
      headers: {
        "Cf-Access-Authenticated-User-Email": accessEmail,
      },
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(versionResponse.status, 200);
    const versionOne = await readJson(versionResponse);
    assert.equal(versionOne.version.sequence, 1);
    assert.equal(versionOne.data.name, "Alpha");

    const restoreUrl = new URL(`/api/tateside/schematics/${created.schematic.id}/restore`, server.baseUrl);
    const restoreResponse = await fetch(restoreUrl, {
      method: "POST",
      headers: requestHeaders(),
      body: JSON.stringify({
        sequence: 1,
        source: "route-test-restore",
      }),
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(restoreResponse.status, 200);
    const restored = await readJson(restoreResponse);
    assert.equal(restored.version.sequence, 3);
    assert.equal(restored.data.name, "Alpha");
    assert.equal(restored.version.source, "route-test-restore");
    assert.equal(restored.schematic.updatedByEmail, accessEmail);

    const invalidBodyResponse = await fetch(listUrl, {
      method: "POST",
      headers: requestHeaders(),
      body: JSON.stringify([]),
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(invalidBodyResponse.status, 400);
    assert.deepEqual(await readJson(invalidBodyResponse), {
      error: "Request body must be a JSON object",
    });

    const invalidSequenceResponse = await fetch(
      new URL(`/api/tateside/schematics/${created.schematic.id}/versions/not-a-number`, server.baseUrl),
      {
        headers: {
          "Cf-Access-Authenticated-User-Email": accessEmail,
        },
        signal: AbortSignal.timeout(5_000),
      },
    );
    assert.equal(invalidSequenceResponse.status, 400);
    assert.deepEqual(await readJson(invalidSequenceResponse), {
      error: "sequence must be a positive safe integer",
    });
  } finally {
    await server.stop();
  }
});
