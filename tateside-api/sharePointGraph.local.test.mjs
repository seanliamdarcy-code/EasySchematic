import assert from "node:assert/strict";
import test from "node:test";

import {
  SharePointGraphError,
  createSharePointGraphClient,
} from "../dist-tateside-api/tateside-api/src/sharePointGraph.js";

const sharePointConfig = {
  tenantId: "tenant-1",
  clientId: "client-1",
  clientSecret: "secret-1",
  siteId: "site-1",
  driveId: "drive-1",
  rootFolderId: "root",
  identityBaseUrl: "http://identity.local",
  graphBaseUrl: "http://graph.local/v1.0",
};

function makeSchematic(name) {
  return {
    version: 1,
    name,
    nodes: [],
    edges: [],
  };
}

function graphItem(id, name, type, parentId = null, overrides = {}) {
  return {
    id,
    name,
    webUrl: `https://sharepoint.local/${id}`,
    size: type === "file" ? 64 : 0,
    lastModifiedDateTime: "2026-06-22T00:00:00.000Z",
    parentReference: {
      driveId: sharePointConfig.driveId,
      siteId: sharePointConfig.siteId,
      ...(parentId ? { id: parentId } : {}),
    },
    ...(type === "folder" ? { folder: {} } : { file: {} }),
    ...overrides,
  };
}

function jsonResponse(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: {
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

function textResponse(body, init = {}) {
  return new Response(body, {
    status: init.status ?? 200,
    headers: init.headers,
  });
}

function redirectResponse(location) {
  return new Response(null, {
    status: 302,
    headers: {
      location,
    },
  });
}

function makeMockFetch() {
  const requests = [];
  let tokenRequests = 0;

  const items = new Map([
    ["root", graphItem("root", "Schematics", "folder")],
    ["folder-a", graphItem("folder-a", "Projects", "folder", "root")],
    ["file-1", graphItem("file-1", "Nested.json", "file", "folder-a")],
    ["file-direct", graphItem("file-direct", "Direct.json", "file", "root", { size: 48 })],
    ["upl-1", graphItem("upl-1", "Upload Name.json", "file", "folder-a")],
    ["escape", graphItem("escape", "Escaped.json", "file", "outside-root")],
    ["outside-root", graphItem("outside-root", "Outside", "folder")],
    ["missing", null],
    ["graph-bad", null],
  ]);

  const fetchMock = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init.method ?? "GET";
    const headers = new Headers(init.headers ?? {});
    const bodyText = typeof init.body === "string"
      ? init.body
      : init.body instanceof URLSearchParams
        ? init.body.toString()
        : null;

    requests.push({
      url,
      method,
      headers,
      bodyText,
      redirect: init.redirect ?? "follow",
    });

    const parsed = new URL(url);
    if (parsed.origin === "http://identity.local") {
      tokenRequests += 1;
      assert.equal(method, "POST");
      assert.equal(headers.get("content-type"), "application/x-www-form-urlencoded");
      return jsonResponse({ access_token: "token-1", expires_in: 3600 });
    }

    if (parsed.origin === "http://graph.local") {
      assert.equal(headers.get("authorization"), "Bearer token-1");

      if (method === "PUT" && parsed.pathname === "/v1.0/drives/drive-1/items/folder-a:/Upload%20Name.json:/content") {
        return jsonResponse(items.get("upl-1"));
      }

      if (method === "GET" && parsed.pathname === "/v1.0/drives/drive-1/items/root/children") {
        return jsonResponse({
          value: [
            items.get("folder-a"),
            items.get("file-direct"),
          ],
          "@odata.nextLink": "http://graph.local/v1.0/drives/drive-1/items/root/children?$skiptoken=root-page-2",
        });
      }

      if (method === "GET" && parsed.pathname === "/v1.0/drives/drive-1/items/folder-a/children") {
        return jsonResponse({
          value: [items.get("file-1")],
        });
      }

      if (method === "GET" && parsed.pathname === "/v1.0/drives/drive-1/items/root/children-bad") {
        return jsonResponse({
          value: [],
          "@odata.nextLink": "http://evil.local/v1.0/drives/drive-1/items/root/children?$skiptoken=evil",
        });
      }

      if (method === "GET" && parsed.pathname.startsWith("/v1.0/drives/drive-1/items/") && parsed.pathname.endsWith("/content")) {
        const itemId = decodeURIComponent(parsed.pathname.split("/")[5]);
        if (itemId === "file-1") {
          return redirectResponse("http://download.local/files/file-1?sig=abc");
        }
        if (itemId === "file-direct") {
          return textResponse(JSON.stringify(makeSchematic("Direct graph content")));
        }
      }

      if (method === "GET" && parsed.pathname.startsWith("/v1.0/drives/drive-1/items/")) {
        const itemId = decodeURIComponent(parsed.pathname.split("/")[5] ?? "");
        if (itemId === "missing") {
          return jsonResponse({
            error: {
              code: "itemNotFound",
              message: "super secret upstream path should not leak",
            },
          }, { status: 404 });
        }
        if (itemId === "graph-bad") {
          return jsonResponse({
            error: {
              code: "invalidRequest",
              message: "contains tenant details",
            },
          }, { status: 400 });
        }
        const item = items.get(itemId);
        if (item == null) {
          return jsonResponse({
            error: {
              code: "itemNotFound",
            },
          }, { status: 404 });
        }
        return jsonResponse(item);
      }
    }

    if (parsed.origin === "http://download.local") {
      assert.equal(headers.get("authorization"), null);
      assert.equal(init.redirect, "manual");
      return textResponse(JSON.stringify(makeSchematic("Redirected graph content")));
    }

    throw new Error(`Unexpected request: ${method} ${url}`);
  };

  return {
    fetchMock,
    requests,
    getTokenRequests() {
      return tokenRequests;
    },
  };
}

async function expectGraphError(action, status, message) {
  await assert.rejects(action, (error) => {
    assert.ok(error instanceof SharePointGraphError);
    assert.equal(error.status, status);
    assert.equal(error.message, message);
    return true;
  });
}

test("sharePointGraph reuses tokens and lists configured root content with breadcrumbs", async () => {
  const mock = makeMockFetch();
  const client = createSharePointGraphClient(sharePointConfig, 4096, {
    fetch: mock.fetchMock,
    now: () => 1_000,
  });

  const rootList = await client.listFolderChildren(null, { pageSize: 10 });
  assert.equal(rootList.folder.id, "root");
  assert.deepEqual(rootList.breadcrumbs.map((item) => item.id), ["root"]);
  assert.deepEqual(rootList.items.map((item) => item.id), ["folder-a", "file-direct"]);
  assert.ok(rootList.nextPageToken);

  const nestedList = await client.listFolderChildren("folder-a");
  assert.equal(nestedList.folder.id, "folder-a");
  assert.deepEqual(nestedList.breadcrumbs.map((item) => item.id), ["root", "folder-a"]);
  assert.deepEqual(nestedList.items.map((item) => item.id), ["file-1"]);

  const pagedRootList = await client.listFolderChildren("root", {
    pageToken: rootList.nextPageToken,
  });
  assert.deepEqual(pagedRootList.items.map((item) => item.id), ["folder-a", "file-direct"]);
  assert.equal(mock.getTokenRequests(), 1);
});

test("sharePointGraph rejects root escapes, forged page tokens, and malformed next links", async () => {
  const mock = makeMockFetch();
  const client = createSharePointGraphClient(sharePointConfig, 4096, {
    fetch: mock.fetchMock,
    now: () => 1_000,
  });

  await expectGraphError(
    () => client.resolveMetadata("escape"),
    403,
    "SharePoint item is outside the configured root",
  );

  const forgedToken = Buffer.from(
    "http://graph.local/v1.0/drives/drive-1/items/root/versions?$skiptoken=forged",
    "utf8",
  ).toString("base64url");
  await expectGraphError(
    () => client.listFolderChildren("root", { pageToken: forgedToken }),
    400,
    "page token is invalid",
  );

  const malformedClient = createSharePointGraphClient(sharePointConfig, 4096, {
    fetch: async (input, init = {}) => {
      const url = typeof input === "string" ? input : input.toString();
      const parsed = new URL(url);
      if (parsed.origin === "http://identity.local") {
        return jsonResponse({ access_token: "token-1", expires_in: 3600 });
      }
      if (parsed.pathname === "/v1.0/drives/drive-1/items/root") {
        return jsonResponse(graphItem("root", "Schematics", "folder"));
      }
      if (parsed.pathname === "/v1.0/drives/drive-1/items/root/children") {
        return jsonResponse({
          value: [],
          "@odata.nextLink": "http://evil.local/v1.0/drives/drive-1/items/root/children?$skiptoken=evil",
        });
      }
      throw new Error(`Unexpected request: ${url} ${init.method ?? "GET"}`);
    },
    now: () => 1_000,
  });

  await expectGraphError(
    () => malformedClient.listFolderChildren("root"),
    502,
    "page token is invalid",
  );
});

test("sharePointGraph validates upload filenames and uploads JSON with the expected Graph request", async () => {
  const mock = makeMockFetch();
  const client = createSharePointGraphClient(sharePointConfig, 4096, {
    fetch: mock.fetchMock,
    now: () => 1_000,
  });

  for (const invalidName of ["bad/name.json", "bad<name>.json", ".", "..", "bad.json ", "bad?.json"]) {
    await expectGraphError(
      () => client.uploadSchematic("folder-a", invalidName, makeSchematic("Bad")),
      400,
      invalidName === "." || invalidName === ".." || invalidName === "bad.json "
        ? "file name must not end with a dot or space"
        : "file name contains invalid characters",
    );
  }

  const uploaded = await client.uploadSchematic("folder-a", "Upload Name.json", makeSchematic("Uploaded"));
  assert.equal(uploaded.id, "upl-1");
  assert.equal(uploaded.type, "file");

  const putRequest = mock.requests.find((request) =>
    request.method === "PUT"
    && request.url === "http://graph.local/v1.0/drives/drive-1/items/folder-a:/Upload%20Name.json:/content?@microsoft.graph.conflictBehavior=replace");
  assert.ok(putRequest);
  assert.equal(putRequest.headers.get("content-type"), "application/json; charset=utf-8");
  assert.deepEqual(JSON.parse(putRequest.bodyText), makeSchematic("Uploaded"));
});

test("sharePointGraph downloads direct content and redirected content without leaking auth", async () => {
  const mock = makeMockFetch();
  const client = createSharePointGraphClient(sharePointConfig, 4096, {
    fetch: mock.fetchMock,
    now: () => 1_000,
  });

  const redirected = await client.downloadSchematic("file-1");
  assert.equal(redirected.name, "Redirected graph content");

  const direct = await client.downloadSchematic("file-direct");
  assert.equal(direct.name, "Direct graph content");

  const redirectRequests = mock.requests.filter((request) => request.url.startsWith("http://download.local/"));
  assert.equal(redirectRequests.length, 1);
  assert.equal(redirectRequests[0].headers.get("authorization"), null);
});

test("sharePointGraph maps Graph errors to safe client-facing messages", async () => {
  const mock = makeMockFetch();
  const client = createSharePointGraphClient(sharePointConfig, 4096, {
    fetch: mock.fetchMock,
    now: () => 1_000,
  });

  await expectGraphError(
    () => client.resolveMetadata("missing"),
    404,
    "SharePoint item not found",
  );

  await expectGraphError(
    () => client.resolveMetadata("graph-bad"),
    400,
    "SharePoint request was invalid",
  );
});

test("sharePointGraph uploadSchematic rejects when Graph PUT response identifies file outside configured root", async () => {
  const escapeItem = graphItem("escape", "Escaped.json", "file", "outside-root");
  const outsideRootFolder = graphItem("outside-root", "Outside", "folder");
  const folderAItem = graphItem("folder-a", "Projects", "folder", "root");
  const rootItem = graphItem("root", "Schematics", "folder");
  const requests = [];

  const fetchMock = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init.method ?? "GET";
    const headers = new Headers(init.headers ?? {});
    requests.push({ url, method });

    const parsed = new URL(url);
    if (parsed.origin === "http://identity.local") {
      return jsonResponse({ access_token: "token-1", expires_in: 3600 });
    }

    if (parsed.origin === "http://graph.local") {
      if (method === "GET" && parsed.pathname === "/v1.0/drives/drive-1/items/folder-a") {
        return jsonResponse(folderAItem);
      }
      if (method === "GET" && parsed.pathname === "/v1.0/drives/drive-1/items/root") {
        return jsonResponse(rootItem);
      }
      if (method === "GET" && parsed.pathname === "/v1.0/drives/drive-1/items/escape") {
        return jsonResponse(escapeItem);
      }
      if (method === "GET" && parsed.pathname === "/v1.0/drives/drive-1/items/outside-root") {
        return jsonResponse(outsideRootFolder);
      }
      if (method === "PUT" && parsed.pathname.includes("/content")) {
        return jsonResponse({ id: "escape", name: "BadUpload.json", file: {} });
      }
      if (method === "GET" && parsed.pathname.startsWith("/v1.0/drives/drive-1/items/")) {
        const itemId = decodeURIComponent(parsed.pathname.split("/")[5] ?? "");
        if (itemId === "folder-a") return jsonResponse(folderAItem);
        if (itemId === "root") return jsonResponse(rootItem);
        if (itemId === "escape") return jsonResponse(escapeItem);
        if (itemId === "outside-root") return jsonResponse(outsideRootFolder);
      }
      throw new Error(`Unexpected graph request: ${method} ${url}`);
    }

    throw new Error(`Unexpected request: ${method} ${url}`);
  };

  const client = createSharePointGraphClient(sharePointConfig, 4096, {
    fetch: fetchMock,
    now: () => 1_000,
  });

  await expectGraphError(
    () => client.uploadSchematic("folder-a", "BadUpload.json", makeSchematic("Bad")),
    403,
    "SharePoint item is outside the configured root",
  );

  const putRequest = requests.find((r) => r.method === "PUT");
  assert.ok(putRequest);
});

test("sharePointGraph download rejects when Content-Length or body exceeds limit despite small metadata size", async () => {
  const makeSmallItem = (id, name) =>
    graphItem(id, name, "file", "root", { size: 99 });
  const rootItem = graphItem("root", "Schematics", "folder");
  const requests = [];

  const fetchMock = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init.method ?? "GET";
    const headers = new Headers(init.headers ?? {});
    requests.push({ url, method, redirect: init.redirect ?? "follow" });

    const parsed = new URL(url);
    if (parsed.origin === "http://identity.local") {
      return jsonResponse({ access_token: "token-1", expires_in: 3600 });
    }

    if (parsed.origin === "http://graph.local") {
      if (method === "GET" && parsed.pathname.startsWith("/v1.0/drives/drive-1/items/") && parsed.pathname.endsWith("/content")) {
        const itemId = decodeURIComponent(parsed.pathname.split("/")[5]);
        if (itemId === "oversize-cl") {
          // oversized numeric Content-Length; should reject before reading body
          return new Response("tiny", {
            status: 200,
            headers: { "content-length": "99999" },
          });
        }
        if (itemId === "oversize-body") {
          // no oversized CL (or omitted), body exceeds during incremental read
          return new Response("x".repeat(8192), { status: 200 });
        }
      }
      if (method === "GET" && parsed.pathname.startsWith("/v1.0/drives/drive-1/items/")) {
        const itemId = decodeURIComponent(parsed.pathname.split("/")[5] ?? "");
        if (itemId === "oversize-cl") {
          return jsonResponse(makeSmallItem("oversize-cl", "OversizeCL.json"));
        }
        if (itemId === "oversize-body") {
          return jsonResponse(makeSmallItem("oversize-body", "OversizeBody.json"));
        }
        if (itemId === "root") {
          return jsonResponse(rootItem);
        }
      }
      throw new Error(`Unexpected graph request: ${method} ${url}`);
    }

    throw new Error(`Unexpected request: ${method} ${url}`);
  };

  const client = createSharePointGraphClient(sharePointConfig, 4096, {
    fetch: fetchMock,
    now: () => 1_000,
  });

  await expectGraphError(
    () => client.downloadSchematic("oversize-cl"),
    400,
    "schematic JSON exceeds 4096 bytes",
  );

  await expectGraphError(
    () => client.downloadSchematic("oversize-body"),
    400,
    "schematic JSON exceeds 4096 bytes",
  );
});

