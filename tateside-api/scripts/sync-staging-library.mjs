#!/usr/bin/env node
/**
 * One-way sync of active production device library into a staging DB.
 * Usage (after build):
 *   node tateside-api/scripts/sync-staging-library.mjs --source /path/to/prod.db --destination /path/to/staging.db
 *
 * Invoked via: npm run tateside:library:sync-staging -- --source ... --destination ...
 */

import path from "node:path";
import { syncDeviceLibraryFromProd } from "../../dist-tateside-api/tateside-api/src/librarySync.js";

function parseArgs(argv) {
  const args = argv.slice(2);
  let source = undefined;
  let destination = undefined;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--source" && i + 1 < args.length) {
      source = args[i + 1];
      i += 1;
    } else if (args[i] === "--destination" && i + 1 < args.length) {
      destination = args[i + 1];
      i += 1;
    }
  }
  return { source, destination };
}

const { source, destination } = parseArgs(process.argv);

if (!source || !destination) {
  console.error("Usage: npm run tateside:library:sync-staging -- --source <prod-db-path> --destination <staging-db-path>");
  process.exit(1);
}

try {
  const result = syncDeviceLibraryFromProd({ sourcePath: source, destinationPath: destination });
  console.log(`Synced ${result.devicesCopied} active device(s) and ${result.versionsCopied} version record(s) to staging library.`);
  console.log("One-way production -> staging library refresh complete.");
  console.log("- production schematics are not copied;");
  console.log("- staging schematics are preserved;");
  console.log("- staging device audit history is reset by the library refresh.");
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`Sync failed: ${message}`);
  process.exit(1);
}
