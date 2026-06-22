import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const npmCliPath = process.env.npm_execpath;
const configuredApiTarget = process.env.TATESIDE_DEV_API_TARGET
  ? new URL(process.env.TATESIDE_DEV_API_TARGET)
  : null;

if (configuredApiTarget && (
  configuredApiTarget.protocol !== "http:" ||
  configuredApiTarget.pathname !== "/" ||
  configuredApiTarget.search ||
  configuredApiTarget.hash
)) {
  throw new Error("TATESIDE_DEV_API_TARGET must be an http origin without a path, query, or hash.");
}

const apiPort = Number(process.env.TATESIDE_API_PORT || configuredApiTarget?.port || "8788");
if (!Number.isInteger(apiPort) || apiPort < 1 || apiPort > 65535) {
  throw new Error(`TATESIDE_API_PORT must be a valid TCP port; received ${process.env.TATESIDE_API_PORT ?? configuredApiTarget?.port ?? ""}`);
}

const apiHost = process.env.TATESIDE_API_HOST || configuredApiTarget?.hostname || "127.0.0.1";
const targetHost = apiHost === "0.0.0.0" || apiHost === "::" ? "127.0.0.1" : apiHost;
const targetHostForUrl = targetHost.includes(":") ? `[${targetHost}]` : targetHost;
const apiBaseUrl = configuredApiTarget ?? new URL(`http://${targetHostForUrl}:${apiPort}`);
apiBaseUrl.port = String(apiPort);
const sharedEnv = {
  ...process.env,
  TATESIDE_API_HOST: apiHost,
  TATESIDE_API_PORT: String(apiPort),
  TATESIDE_DEV_API_TARGET: apiBaseUrl.origin,
  EASYSCHEMATIC_FULL_STACK_DEV: "1",
};

const children = [];
let shuttingDown = false;

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(true);
  }

  return new Promise((resolve) => {
    const onExit = () => {
      clearTimeout(timeout);
      resolve(true);
    };
    const timeout = setTimeout(() => {
      child.removeListener("exit", onExit);
      resolve(false);
    }, timeoutMs);
    child.once("exit", onExit);
  });
}

async function stopChild({ label, child }) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  if (process.platform === "win32") {
    await new Promise((resolve) => {
      const taskkill = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      taskkill.once("error", resolve);
      taskkill.once("close", resolve);
    });
    await waitForExit(child, 5_000);
    return;
  }

  const signalTree = (signal) => {
    try {
      process.kill(-child.pid, signal);
    } catch {
      child.kill(signal);
    }
  };

  signalTree("SIGTERM");
  if (await waitForExit(child, 5_000)) {
    return;
  }

  console.warn(`[dev:full] ${label} did not stop after SIGTERM; forcing shutdown.`);
  signalTree("SIGKILL");
  await waitForExit(child, 2_000);
}

async function shutdown(exitCode) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  await Promise.all([...children].reverse().map(stopChild));
  process.exitCode = exitCode;
}

function spawnNpm(scriptName, detached = false) {
  const options = {
    cwd: projectRoot,
    env: sharedEnv,
    stdio: "inherit",
    // POSIX process groups let shutdown terminate npm and every watcher it owns.
    detached: detached && process.platform !== "win32",
    windowsHide: true,
  };

  if (npmCliPath) {
    return spawn(process.execPath, [npmCliPath, "run", scriptName], options);
  }

  return spawn(process.platform === "win32" ? "npm.cmd" : "npm", ["run", scriptName], options);
}

function runNpmOnce(scriptName) {
  return new Promise((resolve, reject) => {
    const child = spawnNpm(scriptName);

    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`npm run ${scriptName} failed (${signal || `exit code ${code}`})`));
    });
  });
}

function startNpm(label, scriptName) {
  const child = spawnNpm(scriptName, true);
  const managedChild = { label, child };
  children.push(managedChild);

  child.once("error", (error) => {
    if (!shuttingDown) {
      console.error(`[dev:full] ${label} could not start: ${error.message}`);
      void shutdown(1);
    }
  });

  child.once("exit", (code, signal) => {
    if (!shuttingDown) {
      console.error(`[dev:full] ${label} stopped unexpectedly (${signal || `exit code ${code}`}).`);
      void shutdown(code && code !== 0 ? code : 1);
    }
  });

  return managedChild;
}

async function waitForApi(apiChild) {
  const healthUrl = new URL("/health", apiBaseUrl);
  const deadline = Date.now() + 20_000;
  let lastError = "No response received";

  while (Date.now() < deadline) {
    if (apiChild.child.exitCode !== null || apiChild.child.signalCode !== null) {
      throw new Error("TateSide API stopped before it became ready.");
    }

    try {
      const response = await fetch(healthUrl, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) {
        const body = await response.json();
        if (body?.ok === true && body?.service === "tateside-api") {
          return;
        }
        lastError = "Health endpoint returned an unexpected response";
      } else {
        lastError = `Health endpoint returned ${response.status}`;
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }

    await wait(250);
  }

  throw new Error(`TateSide API was not ready at ${healthUrl} within 20 seconds: ${lastError}`);
}

process.once("SIGINT", () => {
  console.log("\n[dev:full] Stopping local API and Vite server...");
  void shutdown(0);
});
process.once("SIGTERM", () => {
  console.log("\n[dev:full] Stopping local API and Vite server...");
  void shutdown(0);
});
async function main() {
  console.log(`[dev:full] Building TateSide API for ${apiBaseUrl.origin}...`);
  await runNpmOnce("tateside:api:build");

  startNpm("TateSide API compiler", "tateside:api:watch");
  const apiChild = startNpm("TateSide API", "tateside:api:watch:serve");
  await waitForApi(apiChild);

  startNpm("Vite frontend", "dev");
  console.log(`[dev:full] TateSide API is ready at ${apiBaseUrl.origin}; Vite now proxies /api/tateside locally.`);
}

main().catch((error) => {
  console.error(`[dev:full] ${error instanceof Error ? error.message : String(error)}`);
  void shutdown(1);
});
