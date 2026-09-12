/**
 * pi-phoenix — Arize Phoenix OTLP tracing for pi.
 *
 * Creates one trace per agent turn:
 *   pi.turn            (before_agent_start → agent_settled)
 *     ├─ llm.call      (per assistant message, token/cost usage)
 *     └─ tool.execute  (per tool execution)
 *
 * Config (env overrides conf file):
 *   PI_PHOENIX_URL    e.g. https://ttdudd7d--phoenix.modal.run
 *   PI_PHOENIX_TOKEN  Modal proxy token "wk-xxx.ws-yyy" (Bearer)
 * Conf file: ~/.local/etc/pi-memory.conf  (UNIFIED, KEY=VALUE lines)
 *   — same file is read by bin/qmd-server and bin/qmd-shim; override with
 *   PI_MEMORY_CONF=/path/to/file
 *
 * Project name in Phoenix: "pi" (resource service.name).
 * If URL/token missing the extension stays inert — zero overhead.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import * as _sdk from "@opentelemetry/sdk-trace-base";
import * as _otlp from "@opentelemetry/exporter-trace-otlp-proto";
import * as _res from "@opentelemetry/resources";
import * as _api from "@opentelemetry/api";

// Defensive destructure — survives CJS/ESM interop quirks under jiti
const api: any = (_api as any).default ?? _api;
const sdk: any = (_sdk as any).default ?? _sdk;
const otlp: any = (_otlp as any).default ?? _otlp;
const resm: any = (_res as any).default ?? _res;
const SpanKind = api.SpanKind ?? { INTERNAL: 0, CLIENT: 3 };
const SpanStatusCode = api.SpanStatusCode ?? { ERROR: 2, OK: 1 };
const context = api.context;
const trace = api.trace;
const BatchSpanProcessor = sdk.BatchSpanProcessor;
const BasicTracerProvider = sdk.BasicTracerProvider;
const OTLPTraceExporter = otlp.OTLPTraceExporter;
const Resource = resm.Resource;

interface Conf { url?: string; token?: string; project?: string }

function confPath(): string {
	return process.env.PI_MEMORY_CONF ?? join(homedir(), ".local", "etc", "pi-memory.conf");
}

function loadConf(): Conf {
	const c: Conf = {
		url: process.env.PI_PHOENIX_URL,
		token: process.env.PI_PHOENIX_TOKEN,
		project: process.env.PI_PHOENIX_PROJECT ?? "pi",
	};
	let modalKey: string | undefined;
	let modalSecret: string | undefined;
	try {
		const txt = readFileSync(confPath(), "utf8");
		for (const line of txt.split("\n")) {
			const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.+?)\s*$/);
			if (!m) continue;
			if (m[1] === "PI_PHOENIX_URL" && !c.url) c.url = m[2];
			if (m[1] === "PI_PHOENIX_TOKEN" && !c.token) c.token = m[2];
			if (m[1] === "MODAL_KEY") modalKey = m[2];
			if (m[1] === "MODAL_SECRET") modalSecret = m[2];
		}
	} catch { /* no conf file */ }
	// Fallback: when only one Modal proxy token is configured (setup.sh writes
	// a single pair), derive the Phoenix bearer as MODAL_KEY.MODAL_SECRET.
	if (!c.token && modalKey && modalSecret) c.token = `${modalKey}.${modalSecret}`;
	return c;
}

export default function (pi: ExtensionAPI) {
	const conf = loadConf();
	if (!conf.url || !conf.token) {
		console.log("[pi-phoenix] not configured (no URL/token) — inert");
		return;
	}

	const exporter = new OTLPTraceExporter({
		url: `${conf.url.replace(/\/$/, "")}/v1/traces`,
		headers: { authorization: `Bearer ${conf.token}` },
		timeoutMillis: 120_000, // Modal cold start can take ~30-60s
	});
	// OTel diag is a process-wide singleton: a second setLogger (e.g. after
	// /reload) logs "Current logger will overwrite one already registered",
	// and at ERROR level every OTLP export failure becomes a noisy popup.
	// Keep it opt-in via PI_PHOENIX_DEBUG=1.
	if (process.env.PI_PHOENIX_DEBUG === "1") {
		try {
			(api.diag ?? ({ setLogger() {} })).setLogger(
				new (api.DiagConsoleLogger ?? function () {})(
					(api.DiagLogLevel ?? { INFO: 30, ERROR: 50 }).ERROR
				)
			);
		} catch { /* ignore */ }
	}
	const provider = new BasicTracerProvider({
		resource: new Resource({
			"service.name": conf.project ?? "pi",
			"service.namespace": "pi-coding-agent",
			// Phoenix groups traces by this attribute (not service.name)
			"openinference.project.name": conf.project ?? "pi",
		}),
	});
	provider.addSpanProcessor(new BatchSpanProcessor(exporter, { scheduledDelayMillis: 5000 }));
	// bind tracer DIRECTLY to this provider — immune to global-registry/dual-copy hazards
	const tracer = provider.getTracer("pi-phoenix", "1.0.0");

	let turnSpan: any = null;

	pi.on("before_agent_start", async (event, ctx) => {
		try {
			turnSpan?.end(); // safety: previous turn never settled
			let modelName = "?";
			try { modelName = `${ctx.model.provider}/${ctx.model.id}`; } catch { /* noop */ }
			turnSpan = tracer.startSpan("pi.turn", {
				kind: SpanKind.INTERNAL,
				startTime: Date.now(),
				attributes: {
					"openinference.span.kind": "AGENT",
					"pi.prompt": String(event.prompt ?? "").slice(0, 2000),
					"session.model": modelName,
				},
			});
		} catch (e) { console.error("[pi-phoenix]", e); }
		return undefined;
	});

	pi.on("message_end", async (event) => {
		if (!turnSpan || event.message.role !== "assistant") return;
		try {
			const m: any = event.message;
			const usage = m.usage ?? {};
			const cost = usage.cost ?? {};
			const span = tracer.startSpan("llm.call", {
				kind: SpanKind.CLIENT,
				startTime: m.timestamp ?? Date.now(),
				attributes: {
					"openinference.span.kind": "LLM",
					"llm.model_name": String(m.modelID ?? m.model ?? "?"),
					"llm.provider": String(m.provider ?? "?"),
					"llm.token_count.prompt": usage.input ?? 0,
					"llm.token_count.completion": usage.output ?? 0,
					"llm.token_count.total": (usage.input ?? 0) + (usage.output ?? 0),
					"llm.cost.total": cost.total ?? 0,
					"llm.stop_reason": m.stopReason ?? "",
				},
			}, trace.setSpan(context.active(), turnSpan));
			// first text block as a light preview
			const txt = Array.isArray(m.content)
				? m.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join(" ")
				: "";
			if (txt) span.setAttribute("llm.preview", String(txt).slice(0, 500));
			span.end(Date.now());
		} catch (e) { console.error("[pi-phoenix]", e); }
		return undefined;
	});

	let toolSpans = new Map<string, any>();
	pi.on("tool_execution_start", async (event) => {
		if (!turnSpan) return;
		try {
			const span = tracer.startSpan(`tool.execute ${event.toolName}`, {
				kind: SpanKind.INTERNAL,
				startTime: Date.now(),
				attributes: {
					"openinference.span.kind": "TOOL",
					"tool.name": event.toolName,
					"tool.args": JSON.stringify(event.args ?? {}).slice(0, 1000),
				},
			}, trace.setSpan(context.active(), turnSpan));
			toolSpans.set(event.toolCallId, span);
		} catch (e) { console.error("[pi-phoenix]", e); }
		return undefined;
	});

	pi.on("tool_execution_end", async (event) => {
		const span = toolSpans.get(event.toolCallId);
		if (!span) return;
		try {
			if (event.isError) {
				span.setStatus({ code: SpanStatusCode.ERROR });
				const r: any = event.result;
				const errText = JSON.stringify(r?.content ?? r ?? "").slice(0, 500);
				span.setAttribute("error.message", errText);
			}
		} catch { /* ignore */ }
		finally {
			span.end(Date.now());
			toolSpans.delete(event.toolCallId);
		}
		return undefined;
	});

	pi.on("agent_settled", async () => {
		try {
			for (const [, s] of toolSpans) s.end();
			toolSpans.clear();
			turnSpan?.end(Date.now());
			turnSpan = null;
		} catch (e) { console.error("[pi-phoenix]", e); }
		return undefined;
	});

	pi.on("session_shutdown", async () => {
		try { await provider.forceFlush(); } catch { /* ignore */ }
		return undefined;
	});

	// helper command to verify wiring
	pi.registerCommand("phoenix-status", {
		description: "Show pi-phoenix tracing target",
		handler: async (_args, ctx) => {
			ctx.ui.notify(`[pi-phoenix] exporting to ${conf.url} (project: ${conf.project})`, "info");
		},
	});

	console.log(`[pi-phoenix] tracing → ${conf.url}`);
}
