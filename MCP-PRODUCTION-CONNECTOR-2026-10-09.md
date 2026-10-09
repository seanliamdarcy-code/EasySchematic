# Claude production connector diagnosis

Claude Cowork was configured against the test office connector while the open
schematic was paired to production. The user confirmed that changing Claude to
`https://schematic-mcp-production.tateside.online/mcp` made `get_schematic` work.
The URL selects the environment, not the assistant platform.

The production editor was observed with its office connection enabled and
`Connection: connected`. Its displayed connector URL was the correct production
hostname. Captured browser warning/error logs were empty. Both independent office
services were active; their health endpoints identified the expected production
and test releases. The old service logged startup only, so historical JWT subjects
cannot be reconstructed from its journal. Successful Claude access after changing
only its destination confirms that the production account/relay path works.

Pairing lives in the editor's in-memory Zustand state and the office process's
WebSocket map. It is not localStorage, a database link, or a saved schematic ID.
The `/pair` popup authenticates with Cloudflare Access; only the `/editor` WebSocket
handshake registers the tab. Both MCP HTTP calls and editor upgrades validate a
signed Access JWT (issuer, audience, expiry, subject and email). The routing key is
the normalized email. No direct Microsoft tenant matching is performed by this
relay. Production and test have separate origins, audiences, hostnames and maps.
Unsaved/empty schematics work. Another tab supersedes the same account's connection
in that environment. Reload disables pairing; network drops retry while enabled.

Changes add account/environment-specific errors, authenticated `/status`, and
structured editor/MCP identity logs without tokens, arguments or schematic content.
Preferences displays the verified office email, relay state and last received
assistant command. Account mismatch is checked by comparing those emails; the
server never exposes another staff member's editor to infer a mismatch. There is
no separate "no saved schematic" error because saved IDs are not required.

Validation: 302 application tests, 104 API tests, 19 MCP tests, lint and all 13 isolated
browser tests passed. Browser regression verifies office sign-in, verified email,
relay status, a real `get_schematic` bridge call and disconnect on reload. MCP
tests verify two-account and two-environment isolation, status access protection,
disconnected/expired relay diagnostics and matching logged email/subject.

The frontend and production connector patch `954dc56292cae87af511cac1f060c06c3500f607`
passed GitHub CI run `37943149296` and was activated on the VPS. The unchanged API
remains at `5b2572d`; the test office service remains at `ebfce54`. Frontend and
connector hashes, Docker image digest, unsigned-read rejection, and automatic
reconnection of the existing editor were verified. The deployed Preferences text
was also checked in a separate unpaired browser tab, then that tab was closed.
The original editor remained connected. The browser blocked a separate navigation
to `/status`, so authenticated live `/status` was not verified; its authentication
and per-account results passed fixture tests, and its live unsigned response is 401.

Rollback configuration, artifact checksums, image/health reports and verification
scripts are outside Git in `office-connector-fix-20261009/` in the parent workspace
and `/home/debian/easyschematic-backups/20261009-office-connector-fix` on the VPS.
A fresh encrypted off-VPS data snapshot `552e1887` was taken before activation.
The private configuration rollback archive was copied off-host and checksum-checked;
its local ACL is restricted to the executing user. No data migrations were needed.
