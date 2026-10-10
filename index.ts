#!/usr/bin/env node
/** Executable stdio bootstrap. Import server.ts to construct a server without I/O. */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createBevyServer } from "./server.js";
import { log } from "./src/config.js";
import { bumpBetween } from "./src/store.js";
import { errorMessage } from "./src/types.js";

async function main(): Promise<void> {
  const { server, config, checkVersions, info } = await createBevyServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log(`ready - ${info.name} ${info.version}, bevy ${config.bevyVersion ?? "?"}`);

  const close = () => {
    void server.close().catch((error: unknown) => log(`shutdown: ${errorMessage(error)}`));
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
  const onclose = transport.onclose;
  transport.onclose = () => {
    onclose?.();
    process.removeListener("SIGINT", close);
    process.removeListener("SIGTERM", close);
  };

  // Start renewal only after the handshake transport is available.
  if (config.bevyVersion && !config.env.offline) {
    void checkVersions().then((latest) => {
      if (!latest.ok) return;
      const bump = bumpBetween(config.bevyVersion, latest.newest_stable);
      if (bump.level === "none") return;
      if (!bump.breaksApi) {
        log(`note: bevy ${latest.newest_stable} is available (patch release, no API changes). ` +
          `Your index for ${config.bevyVersion} is still accurate.`);
      } else {
        log(`*** Bevy ${latest.newest_stable} is available and your project is on ` +
          `${config.bevyVersion}. This is a BREAKING release. ***`);
        log(`This index describes ${config.bevyVersion}. Use bevy_check_version and ` +
          `bevy_migration before suggesting API changes.`);
      }
      if (latest.preview && latest.preview !== latest.newest_stable) {
        log(`(${latest.preview} is a pre-release; not recommended.)`);
      }
    }).catch(() => { /* A renewal failure must not break the server. */ });
  }
}

await main().catch((error: unknown) => {
  log(`startup failed: ${errorMessage(error)}`);
  process.exitCode = 1;
});
