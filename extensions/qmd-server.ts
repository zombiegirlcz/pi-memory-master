/**
 * QMD Server Lifecycle — ties the QMD MCP HTTP server to the pi session.
 *
 *   session_start (startup|new|resume)   -> ensure qmd-server is running
 *   session_shutdown (quit)              -> stop qmd-server
 *
 * Session replacements (fork/resume/reload) leave the server running — the
 * replacement session's session_start re-attaches to it because
 * qmd-server start is idempotent (checks the pidfile).
 *
 * The server also self-terminates after 60 min idle via its own watchdog
 * (/usr/local/bin/qmd-server), so a hard-killed pi still gets cleaned up.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	// --- Start/ensure server when a session begins ---------------------------
	pi.on("session_start", async (event, _ctx) => {
		if (event.reason === "startup" || event.reason === "new" || event.reason === "resume") {
			const { stdout } = await pi.exec("qmd-server", ["start"]);
			console.log(`[qmd-server] ${stdout.trim()}`);
		}
	});

	// --- Stop server only when the session truly quits -----------------------
	pi.on("session_shutdown", async (event, _ctx) => {
		if (event.reason !== "quit") return; // fork/resume/reload keep it running
		const { stdout } = await pi.exec("qmd-server", ["stop"]);
		console.log(`[qmd-server] ${stdout.trim()}`);
	});
}