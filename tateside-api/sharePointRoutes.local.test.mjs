import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

const accessEmail = "sp-route-test@example.com";

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
  const deadline = Date.now() + 15_000;
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

function makeGraphFolder(id, name, parentId = null) {
  return {
    id,
    name,
    webUrl: `https://sharepoint.local/${id}`,
    size: 0,
    lastModifiedDateTime: "2026-06-22T00:00:00.000Z",
    parentReference: parentId
      ? { driveId: "drive-1", siteId: "site-1", id: parentId }
      : { driveId: "drive-1", siteId: "site-1" },
    folder: {},
  };
}

function makeGraphFile(id, name, parentId, size = 128) {
  return {
    id,
    name,
    webUrl: `https://sharepoint.local/${id}`,
    size,
    lastModifiedDateTime: "2026-06-22T00:00:00.000Z",
    parentReference: { driveId: "drive-1", siteId: "site-1", id: parentId },
    file: {},
  };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function startApiServerWithSharePoint(mockBase, maxUploadBytes) {
  const root = mkdtempSync(path.join(os.tmpdir(), "tateside-api-sp-routes-"));
  const port = await getAvailablePort();
  const child = spawn(
    process.execPath,
    ["dist-tateside-api/tateside-api/src/server.js"],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_ENV: "test",
        TATESIDE_DATA_DIR: root,
        TATESIDE_API_HOST: "127.0.0.1",
        TATESIDE_API_PORT: String(port),
        TATESIDE_REQUIRE_ACCESS_IDENTITY: "1",
        MS_ENTRA_TENANT_ID: "tenant-1",
        MS_GRAPH_CLIENT_ID: "client-1",
        MS_GRAPH_CLIENT_SECRET: "secret-1",
        TATESIDE_SHAREPOINT_SITE_ID: "site-1",
        TATESIDE_SHAREPOINT_DRIVE_ID: "drive-1",
        TATESIDE_SHAREPOINT_ROOT_FOLDER_ID: "root",
        MS_ENTRA_BASE_URL: mockBase,
        MS_GRAPH_BASE_URL: mockBase,
        ...(maxUploadBytes != null ? { TATESIDE_SHAREPOINT_MAX_UPLOAD_BYTES: String(maxUploadBytes) } : {}),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

  const baseUrl = new URL(`http://127.0.0.1:${port}`);

  try {
    await waitForHealth(baseUrl);
  } catch (error) {
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));
    rmSync(root, { recursive: true, force: true });
    throw new Error(
      `Failed to start TateSide API for SharePoint route test: ${error instanceof Error ? error.message : String(error)}\n${stdout}${stderr}`,
    );
  }

  return {
    baseUrl,
    stdoutRef: () => stdout,
    async stop() {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
      rmSync(root, { recursive: true, force: true });
    },
  };
}

async function startUnconfiguredApiServer() {
  const root = mkdtempSync(path.join(os.tmpdir(), "tateside-api-sp-routes-"));
  const port = await getAvailablePort();
  const child = spawn(
    process.execPath,
    ["dist-tateside-api/tateside-api/src/server.js"],
    {
      cwd: process.cwd(),
      env: (function () {
        const env = { ...process.env };
        delete env.MS_ENTRA_TENANT_ID;
        delete env.MS_GRAPH_CLIENT_ID;
        delete env.MS_GRAPH_CLIENT_SECRET;
        delete env.TATESIDE_SHAREPOINT_SITE_ID;
        delete env.TATESIDE_SHAREPOINT_DRIVE_ID;
        delete env.TATESIDE_SHAREPOINT_ROOT_FOLDER_ID;
        delete env.MS_ENTRA_BASE_URL;
        delete env.MS_GRAPH_BASE_URL;
        env.NODE_ENV = "test";
        env.TATESIDE_DATA_DIR = root;
        env.TATESIDE_API_HOST = "127.0.0.1";
        env.TATESIDE_API_PORT = String(port);
        env.TATESIDE_REQUIRE_ACCESS_IDENTITY = "1";
        return env;
      })(),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

  const baseUrl = new URL(`http://127.0.0.1:${port}`);

  try {
    await waitForHealth(baseUrl);
  } catch (error) {
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));
    rmSync(root, { recursive: true, force: true });
    throw new Error(
      `Failed to start unconfigured TateSide API: ${error instanceof Error ? error.message : String(error)}\n${stdout}${stderr}`,
    );
  }

  return {
    baseUrl,
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

function startMockServer() {
  const requests = [];
  let tokenCount = 0;
  const items = new Map([
    ["root", makeGraphFolder("root", "Schematics")],
    ["folder-a", makeGraphFolder("folder-a", "Projects", "root")],
    ["folder-b", makeGraphFolder("folder-b", "Subfolder", "folder-a")],
    ["file-1", makeGraphFile("file-1", "Nested.json", "folder-a")],
    ["file-direct", makeGraphFile("file-direct", "Direct.json", "root", 64)],
  ]);

  const server = http.createServer((req, res) => {
    handleMockRequest(req, res).catch(() => {
      res.writeHead(500);
      res.end();
    });
  });

  async function handleMockRequest(req, res) {
    const fullUrl = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
    const method = req.method || "GET";

    let body = Buffer.alloc(0);
    if (method === "POST" || method === "PUT" || method === "PATCH") {
      body = await new Promise((resolve, reject) => {
        const chunks = [];
        req.on("data", (chunk) => { chunks.push(chunk); });
        req.on("end", () => { resolve(Buffer.concat(chunks)); });
        req.on("error", reject);
        if (req.readableEnded) {
          resolve(Buffer.concat(chunks));
        }
      });
    }

    requests.push({
      method,
      url: fullUrl.toString(),
      pathname: fullUrl.pathname,
      headers: { ...req.headers },
      body,
    });

    // Token endpoint (identity)
    if (method === "POST" && fullUrl.pathname.includes("/oauth2/v2.0/token")) {
      tokenCount += 1;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ access_token: "mock-token-sp", expires_in: 3600 }));
      return;
    }

    // Graph requests
    if (fullUrl.pathname.startsWith("/drives/")) {
      const auth = req.headers.authorization || "";
      if (!auth.includes("mock-token-sp")) {
        res.writeHead(401);
        res.end();
        return;
      }

      // fetchItem root
      if (method === "GET" && fullUrl.pathname === "/drives/drive-1/items/root") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(items.get("root")));
        return;
      }
      // fetchItem folder-a
      if (method === "GET" && fullUrl.pathname === "/drives/drive-1/items/folder-a") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(items.get("folder-a")));
        return;
      }
      // children root
      if (method === "GET" && fullUrl.pathname === "/drives/drive-1/items/root/children") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          value: [items.get("folder-a"), items.get("file-direct")],
        }));
        return;
      }
      // children folder-a
      if (method === "GET" && fullUrl.pathname === "/drives/drive-1/items/folder-a/children") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ value: [items.get("file-1"), items.get("folder-b")] }));
        return;
      }
      // children folder-b
      if (method === "GET" && fullUrl.pathname === "/drives/drive-1/items/folder-b/children") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ value: [] }));
        return;
      }

      // upload PUT
      if (method === "PUT" && fullUrl.pathname.includes(":/") && fullUrl.pathname.includes("/content")) {
        // Support raw binary body collection without treating as JSON.
        // Return deterministic item based on uploaded fileName so PDF and JSON tests pass.
        // Store so the uploadPdf's requireContainedItem (re-fetch) succeeds for containment.
        let fileNameForUpload = "TestSave.json";
        const nameMatch = fullUrl.pathname.match(/:\/([^:]+):\/content/);
        if (nameMatch && nameMatch[1]) {
          try {
            fileNameForUpload = decodeURIComponent(nameMatch[1]);
          } catch {}
        }
        const size = body ? body.length : 0;
        const uploadId = fileNameForUpload.toLowerCase().endsWith(".pdf") ? "saved-pdf-xyz" : "saved-xyz";
        const uploaded = makeGraphFile(uploadId, fileNameForUpload, "folder-a", size > 0 ? size : 128);
        items.set(uploadId, uploaded);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(uploaded));
        return;
      }

      // fetchItem for uploaded or others
      if (method === "GET" && fullUrl.pathname.startsWith("/drives/drive-1/items/") && !fullUrl.pathname.endsWith("/children") && !fullUrl.pathname.endsWith("/content")) {
        const parts = fullUrl.pathname.split("/");
        const id = decodeURIComponent(parts[parts.length - 1] || "");
        const it = items.get(id);
        if (it) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(it));
          return;
        }
        // missing for error case
        if (id === "missing-file") {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: { code: "itemNotFound", message: "not here" } }));
          return;
        }
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { code: "itemNotFound" } }));
        return;
      }

      // content for download
      if (method === "GET" && fullUrl.pathname.endsWith("/content")) {
        const parts = fullUrl.pathname.split("/");
        const id = decodeURIComponent(parts[parts.length - 2] || "");
        if (id === "file-1") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(makeSchematic("Loaded From SP")));
          return;
        }
        if (id === "file-direct") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(makeSchematic("Direct Load")));
          return;
        }
        res.writeHead(404);
        res.end();
        return;
      }
    }

    res.writeHead(404);
    res.end();
  }

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      const base = `http://127.0.0.1:${port}`;
      resolve({
        base,
        requests,
        getTokenCount: () => tokenCount,
        stop() {
          return new Promise((r) => server.close(r));
        },
      });
    });
  });
}

test("sharepoint routes: configured root listing contract and nested breadcrumb/parent contract", async () => {
  const mock = await startMockServer();
  const server = await startApiServerWithSharePoint(mock.base);
  try {
    // root listing (no folderId)
    const rootUrl = new URL("/api/tateside/sharepoint/children", server.baseUrl);
    const rootRes = await fetch(rootUrl, {
      headers: { "Cf-Access-Authenticated-User-Email": accessEmail },
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(rootRes.status, 200);
    const rootData = await readJson(rootRes);
    assert.equal(rootData.folderId, null);
    assert.equal(rootData.folderName, "Schematics");
    assert.equal(rootData.parentId, null);
    assert.deepEqual(rootData.breadcrumbs, [{ id: null, name: "Schematics" }]);
    assert.equal(rootData.items.length, 2);
    assert.equal(rootData.items[0].id, "folder-a");
    assert.equal(rootData.items[0].type, "folder");
    assert.ok(rootData.items[0].webUrl);
    assert.ok(rootData.items[1].id === "file-direct");

    // nested
    const nestedUrl = new URL("/api/tateside/sharepoint/children?folderId=folder-a", server.baseUrl);
    const nestedRes = await fetch(nestedUrl, {
      headers: { "Cf-Access-Authenticated-User-Email": accessEmail },
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(nestedRes.status, 200);
    const nestedData = await readJson(nestedRes);
    assert.equal(nestedData.folderId, "folder-a");
    assert.equal(nestedData.folderName, "Projects");
    assert.equal(nestedData.parentId, null);
    assert.deepEqual(nestedData.breadcrumbs, [
      { id: null, name: "Schematics" },
      { id: "folder-a", name: "Projects" },
    ]);
    assert.equal(nestedData.items.length, 2);
    assert.ok(nestedData.items.some((item) => item.id === "file-1"));
    assert.ok(nestedData.items.some((item) => item.id === "folder-b" && item.type === "folder"));

    // deeper nested folder-b contract
    const deepUrl = new URL("/api/tateside/sharepoint/children?folderId=folder-b", server.baseUrl);
    const deepRes = await fetch(deepUrl, {
      headers: { "Cf-Access-Authenticated-User-Email": accessEmail },
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(deepRes.status, 200);
    const deepData = await readJson(deepRes);
    assert.equal(deepData.folderId, "folder-b");
    assert.equal(deepData.folderName, "Subfolder");
    assert.equal(deepData.parentId, "folder-a");
    assert.deepEqual(deepData.breadcrumbs, [
      { id: null, name: "Schematics" },
      { id: "folder-a", name: "Projects" },
      { id: "folder-b", name: "Subfolder" },
    ]);
  } finally {
    await server.stop();
    await mock.stop();
  }
});

test("sharepoint routes: missing CF identity yields 401 when required", async () => {
  const mock = await startMockServer();
  const server = await startApiServerWithSharePoint(mock.base);
  try {
    const url = new URL("/api/tateside/sharepoint/children", server.baseUrl);
    const res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    assert.equal(res.status, 401);
    const body = await readJson(res);
    assert.equal(body.error, "Cloudflare Access identity header is required");
  } finally {
    await server.stop();
    await mock.stop();
  }
});

test("sharepoint routes: PUT save forwarded to mock Graph and returns expected metadata", async () => {
  const mock = await startMockServer();
  const server = await startApiServerWithSharePoint(mock.base);
  try {
    const url = new URL("/api/tateside/sharepoint/schematics", server.baseUrl);
    const res = await fetch(url, {
      method: "PUT",
      headers: requestHeaders(),
      body: JSON.stringify({
        folderId: null,
        fileName: "TestSave.json",
        data: makeSchematic("Saved via route"),
      }),
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(res.status, 200);
    const saved = await readJson(res);
    assert.equal(saved.id, "saved-xyz");
    assert.equal(saved.name, "TestSave.json");
    assert.ok(saved.webUrl);

    // verify mock saw PUT
    const putReq = mock.requests.find((r) => r.method === "PUT" && r.url.includes("TestSave.json"));
    assert.ok(putReq, "expected PUT to Graph");
  } finally {
    await server.stop();
    await mock.stop();
  }
});

test("sharepoint routes: GET load returns raw SchematicFile", async () => {
  const mock = await startMockServer();
  const server = await startApiServerWithSharePoint(mock.base);
  try {
    const url = new URL("/api/tateside/sharepoint/schematics/file-1", server.baseUrl);
    const res = await fetch(url, {
      headers: { "Cf-Access-Authenticated-User-Email": accessEmail },
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(res.status, 200);
    const data = await readJson(res);
    assert.equal(data.name, "Loaded From SP");
    assert.equal(data.version, 1);
  } finally {
    await server.stop();
    await mock.stop();
  }
});

test("sharepoint routes: contained Graph error maps safely (404)", async () => {
  const mock = await startMockServer();
  const server = await startApiServerWithSharePoint(mock.base);
  try {
    const url = new URL("/api/tateside/sharepoint/schematics/missing-file", server.baseUrl);
    const res = await fetch(url, {
      headers: { "Cf-Access-Authenticated-User-Email": accessEmail },
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(res.status, 404);
    const body = await readJson(res);
    assert.equal(body.error, "SharePoint item not found");
  } finally {
    await server.stop();
    await mock.stop();
  }
});

test("sharepoint routes: malformed percent-encoded fileId yields 400", async () => {
  const mock = await startMockServer();
  const server = await startApiServerWithSharePoint(mock.base);
  try {
    const urlStr = `${server.baseUrl.origin}/api/tateside/sharepoint/schematics/%E0%A4%A`;
    const res = await fetch(urlStr, {
      headers: { "Cf-Access-Authenticated-User-Email": accessEmail },
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(res.status, 400);
    const body = await readJson(res);
    assert.equal(body.error, "file id is invalid");
  } finally {
    await server.stop();
    await mock.stop();
  }
});

test("sharepoint routes: unconfigured server returns 503 for sharepoint paths", async () => {
  const server = await startUnconfiguredApiServer();
  try {
    // children
    let url = new URL("/api/tateside/sharepoint/children", server.baseUrl);
    let res = await fetch(url, {
      headers: { "Cf-Access-Authenticated-User-Email": accessEmail },
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(res.status, 503);
    let body = await readJson(res);
    assert.equal(body.error, "SharePoint is not configured on the TateSide API server");

    // put
    url = new URL("/api/tateside/sharepoint/schematics", server.baseUrl);
    res = await fetch(url, {
      method: "PUT",
      headers: requestHeaders(),
      body: JSON.stringify({ folderId: null, fileName: "x.json", data: makeSchematic("x") }),
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(res.status, 503);
    body = await readJson(res);
    assert.equal(body.error, "SharePoint is not configured on the TateSide API server");

    // get file
    url = new URL("/api/tateside/sharepoint/schematics/any", server.baseUrl);
    res = await fetch(url, {
      headers: { "Cf-Access-Authenticated-User-Email": accessEmail },
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(res.status, 503);
    body = await readJson(res);
    assert.equal(body.error, "SharePoint is not configured on the TateSide API server");

    // pdf upload (unconfigured)
    url = new URL("/api/tateside/sharepoint/pdfs?folderId=folder-a&fileName=test.pdf", server.baseUrl);
    res = await fetch(url, {
      method: "PUT",
      headers: { "Content-Type": "application/pdf", "Cf-Access-Authenticated-User-Email": accessEmail },
      body: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(res.status, 503);
    body = await readJson(res);
    assert.equal(body.error, "SharePoint is not configured on the TateSide API server");
  } finally {
    await server.stop();
  }
});

test("sharepoint routes: PUT pdfs with application/pdf forwards binary body and returns safe contained metadata", async () => {
  const mock = await startMockServer();
  const server = await startApiServerWithSharePoint(mock.base);
  try {
    // use actual binary Uint8Array body (minimal PDF header bytes)
    const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x35, 0x0a, 0x25]);
    const url = new URL("/api/tateside/sharepoint/pdfs?folderId=folder-a&fileName=Project%20Drawing.pdf", server.baseUrl);
    const res = await fetch(url, {
      method: "PUT",
      headers: {
        "Content-Type": "application/pdf",
        "Cf-Access-Authenticated-User-Email": accessEmail,
      },
      body: pdfBytes,
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(res.status, 200);
    const saved = await readJson(res);
    // safe metadata only
    assert.equal(saved.id, "saved-pdf-xyz");
    assert.equal(saved.name, "Project Drawing.pdf");
    assert.ok(saved.webUrl);

    // assert mock received the exact PUT to expected content path with content-type and exact bytes
    const putReq = mock.requests.find((r) => r.method === "PUT" && r.url.includes("Project%20Drawing.pdf") && r.url.includes("/content"));
    assert.ok(putReq, "expected PUT to Graph content for PDF");
    const ct = putReq.headers["content-type"] || putReq.headers["Content-Type"];
    assert.ok(ct && ct.includes("application/pdf"), "expected application/pdf content-type to Graph");
    const recvBody = putReq.body || Buffer.alloc(0);
    assert.deepEqual([...recvBody], [...pdfBytes], "exact bytes must reach Graph");

    // the upload path internally returned+re-fetched a contained PDF file (for containment check)
    // (verified by 200 success which exercises requireContainedItem after PUT)
  } finally {
    await server.stop();
    await mock.stop();
  }
});

test("sharepoint routes: PUT pdfs with wrong content-type returns 415 safe error and no Graph upload", async () => {
  const mock = await startMockServer();
  const server = await startApiServerWithSharePoint(mock.base);
  try {
    const url = new URL("/api/tateside/sharepoint/pdfs?folderId=folder-a&fileName=test.pdf", server.baseUrl);
    const res = await fetch(url, {
      method: "PUT",
      headers: {
        "Content-Type": "text/plain",
        "Cf-Access-Authenticated-User-Email": accessEmail,
      },
      body: "hello not pdf",
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(res.status, 415);
    const body = await readJson(res);
    assert.equal(body.error, "Content-Type must be application/pdf");

    // no upload attempted to Graph
    const putReq = mock.requests.find((r) => r.method === "PUT" && r.url.includes("/content"));
    assert.ok(!putReq, "no Graph upload on wrong content-type");
  } finally {
    await server.stop();
    await mock.stop();
  }
});

test("sharepoint routes: PUT pdfs exceeding small configured max returns 413 and no Graph upload", async () => {
  const mock = await startMockServer();
  const smallMax = 1024;
  const server = await startApiServerWithSharePoint(mock.base, smallMax);
  try {
    const url = new URL("/api/tateside/sharepoint/pdfs?folderId=folder-a&fileName=big.pdf", server.baseUrl);
    const bigBody = new Uint8Array(1025);
    bigBody.fill(0x41);
    const res = await fetch(url, {
      method: "PUT",
      headers: {
        "Content-Type": "application/pdf",
        "Cf-Access-Authenticated-User-Email": accessEmail,
      },
      body: bigBody,
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(res.status, 413);
    const body = await readJson(res);
    assert.equal(body.error, "Request body is too large");

    // no Graph upload
    const putReq = mock.requests.find((r) => r.method === "PUT" && r.url.includes("/content"));
    assert.ok(!putReq, "no Graph upload when body exceeds configured max");
  } finally {
    await server.stop();
    await mock.stop();
  }
});

test("sharepoint routes: missing CF identity on PDF endpoint returns 401", async () => {
  const mock = await startMockServer();
  const server = await startApiServerWithSharePoint(mock.base);
  try {
    const url = new URL("/api/tateside/sharepoint/pdfs?folderId=folder-a&fileName=test.pdf", server.baseUrl);
    const res = await fetch(url, {
      method: "PUT",
      headers: {
        "Content-Type": "application/pdf",
      },
      body: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(res.status, 401);
    const body = await readJson(res);
    assert.equal(body.error, "Cloudflare Access identity header is required");
  } finally {
    await server.stop();
    await mock.stop();
  }
});
