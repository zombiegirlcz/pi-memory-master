/**
 * pi-phoenix — Arize Phoenix OTLP tracing for pi.
 *
 * Creates one trace per agent turn:
 *   pi.turn            (before_agent_start → agent_settled)
 *     ├─ llm.call      (per assistant message, token/cost usage)
 *     └─ tool.execute  (per tool execution)
 *
 * Phoenix Input/Output columns come from the OpenInference attributes
 * `input.value` / `output.value`. For tools we put the EXACT command pi ran
 * (bash: args.command; others: pretty JSON) into input.value and the tool
 * output into output.value.
 *
 * Project is FIXED to "pi" (no env override). The session folder is attached
 * to every span as `session.cwd` / `session.id` / `session.file`, so you can
 * filter per session inside the project. `/phoenix-url` prints a ready-made
 * link with the Phoenix span filter `spanFilterCondition` applied.
 *
 * Config (env overrides conf file):
 *   PI_PHOENIX_URL      e.g. https://ttdudd7d--phoenix.modal.run
 *   PI_PHOENIX_TOKEN    Modal proxy token "wk-xxx.ws-yyy" (Bearer)
 * Conf file: ~/.local/etc/pi-memory.conf  (UNIFIED, KEY=VALUE lines)
 *   — same file is read by bin/qmd-server and bin/qmd-shim; override with
 *   PI_MEMORY_CONF=/path/to/file
 *
 * If URL/token missing the extension stays inert — zero overhead.
 * A tracing failure can never crash pi: provider init is guarded.
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
// OTel v1 exposed `Resource`; v2 replaced it with `resourceFromAttributes`.
const ResourceCtor = resm.Resource;
const resourceFromAttributes = resm.resourceFromAttributes;
function makeResource(attributes: Record<string, unknown>): unknown {
	if (typeof ResourceCtor === "function") return new ResourceCtor(attributes);
	if (typeof resourceFromAttributes === "function") return resourceFromAttributes(attributes);
	return attributes;
}

const PROJECT = "pi";
interface Conf { url?: string; token?: string }

function confPath(): string {
	return process.env.PI_MEMORY_CONF ?? join(homedir(), ".local", "etc", "pi-memory.conf");
}

function loadConf(): Conf {
	const c: Conf = {
		url: process.env.PI_PHOENIX_URL,
		token: process.env.PI_PHOENIX_TOKEN,
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

const MAX_ATTR = 8000;

function clip(s: string, n = MAX_ATTR): string {
	return s.length > n ? `${s.slice(0, n)}\n…(+${s.length - n} chars)` : s;
}

/** Best-effort text extraction from a pi tool result / message content. */
function readText(value: unknown): string {
	if (value == null) return "";
	if (typeof value === "string") return value;
	if (Array.isArray(value)) return value.map((b) => readText(b)).filter(Boolean).join("\n");
	if (typeof value === "object") {
		const v: any = value;
		if (typeof v.text === "string") return v.text;
		if (typeof v.content === "string") return v.content;
		if (Array.isArray(v.content)) return readText(v.content);
		if (Array.isArray(v.results)) return readText(v.results);
	}
	return "";
}

/** Exact command pi ran: bash exposes args.command; others get pretty JSON. */
function toolInputText(args: unknown): string {
	const a: any = args ?? {};
	if (typeof a.command === "string") return a.command;
	if (typeof a.cmd === "string") return a.cmd;
	try {
		return JSON.stringify(a, null, 2);
	} catch {
		return String(a);
	}
}

/** Phoenix span filter expression for one session folder. */
function filterExpr(cwd: string): string {
	return `session.cwd == '${cwd.replace(/'/g, "\\'")}'`;
}

/** Look up the Phoenix project id by name via the REST API. */
async function projectId(base: string, token: string, name: string): Promise<string | null> {
	try {
		const r = await fetch(`${base.replace(/\/$/, "")}/v1/projects`, {
			headers: { authorization: `Bearer ${token}` },
			signal: AbortSignal.timeout(60_000),
		});
		if (!r.ok) return null;
		const j: any = await r.json();
		const found = (j?.data ?? []).find((p: any) => p?.name === name);
		return found?.id ?? null;
	} catch {
		return null;
	}
}

/** Ready-made Phoenix URL for spans of this session folder. */
async function sessionUrl(base: string, token: string, cwd: string | undefined): Promise<string> {
	const b = base.replace(/\/$/, "");
	const pid = await projectId(b, token, PROJECT);
	const params = new URLSearchParams({ token });
	if (cwd) params.set("spanFilterCondition", filterExpr(cwd));
	const root = pid ? `${b}/projects/${pid}/spans` : `${b}/`;
	return `${root}?${params.toString()}`;
}

export default function (pi: ExtensionAPI) {
	const conf = loadConf();
	if (!conf.url || !conf.token) {
		console.log("[pi-phoenix] not configured (no URL/token) — inert");
		return;
	}
	const baseUrl = conf.url.replace(/\/$/, "");
	const token = conf.token;

	const exporter = new OTLPTraceExporter({
		url: `${baseUrl}/v1/traces`,
		headers: { authorization: `Bearer ${token}` },
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

	let provider: any = null;
	let tracer: any = null;
	try {
		const resource = makeResource({
			"service.name": PROJECT,
			"service.namespace": "pi-coding-agent",
			// Phoenix groups traces into projects by this attribute
			"openinference.project.name": PROJECT,
		});
		const spanProcessor = new BatchSpanProcessor(exporter, { scheduledDelayMillis: 5000 });
		// OTel v2 takes processors via the constructor and removed
		// addSpanProcessor(); v1 needs the explicit addSpanProcessor() call.
		const legacyProvider =
			typeof (BasicTracerProvider as any)?.prototype?.addSpanProcessor === "function";
		provider = legacyProvider
			? new BasicTracerProvider({ resource })
			: new BasicTracerProvider({ resource, spanProcessors: [spanProcessor] });
		if (legacyProvider) provider.addSpanProcessor(spanProcessor);
		tracer = provider.getTracer("pi-phoenix", "1.0.0");
	} catch (e) {
		console.error("[pi-phoenix] tracer provider init failed — extension inert:", e);
		return;
	}

	let turnSpan: any = null;
	let turnPrompt = "";
	let sessionAttrs: Record<string, unknown> = {};
	let sessionCwd: string | undefined;

	pi.on("session_start", async (_event, ctx) => {
		try {
			const sm: any = (ctx as any)?.sessionManager;
			const cwd: string | undefined = sm?.getCwd?.();
			const sid: string | undefined = sm?.getSessionId?.();
			const file: string | undefined = sm?.getSessionFile?.();
			sessionCwd = cwd;
			sessionAttrs = {
				...(sid ? { "session.id": sid } : {}),
				...(cwd ? { "session.cwd": cwd } : {}),
				...(file ? { "session.file": file } : {}),
			};
		} catch (e) {
			console.error("[pi-phoenix] session_start:", e);
		}
		return undefined;
	});

	pi.on("before_agent_start", async (event, ctx) => {
		try {
			turnSpan?.end(); // safety: previous turn never settled
			let modelName = "?";
			try { modelName = `${(ctx as any).model.provider}/${(ctx as any).model.id}`; } catch { /* noop */ }
			turnPrompt = String(event.prompt ?? "");
			turnSpan = tracer.startSpan("pi.turn", {
				kind: SpanKind.INTERNAL,
				startTime: Date.now(),
				attributes: {
					"openinference.span.kind": "AGENT",
					"input.value": clip(turnPrompt),
					"pi.prompt": clip(turnPrompt, 2000),
					"session.model": modelName,
					...sessionAttrs,
				},
			});
		} catch (e) { console.error("[pi-phoenix]", e); }
		return undefined;
	});

	pi.on("message_end", async (event) => {
		if (!turnSpan || event.message.role !== "assistant") return undefined;
		try {
			const m: any = event.message;
			const usage = m.usage ?? {};
			const cost = usage.cost ?? {};
			const outText = readText(m.content);
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
					"input.value": clip(turnPrompt),
					"output.value": clip(outText),
					"llm.preview": clip(outText, 500),
					...sessionAttrs,
				},
			}, trace.setSpan(context.active(), turnSpan));
			span.end(Date.now());
			// keep the last assistant text as the turn output
			if (outText) turnSpan.setAttribute("output.value", clip(outText));
		} catch (e) { console.error("[pi-phoenix]", e); }
		return undefined;
	});

	const toolSpans = new Map<string, any>();
	pi.on("tool_execution_start", async (event) => {
		if (!turnSpan) return undefined;
		try {
			const inputText = clip(toolInputText((event as any).args));
			const span = tracer.startSpan(`tool.execute ${event.toolName}`, {
				kind: SpanKind.INTERNAL,
				startTime: Date.now(),
				attributes: {
					"openinference.span.kind": "TOOL",
					"tool.name": event.toolName,
					"tool.args": inputText,
					"input.value": inputText,
					"input.mime_type": "text/plain",
					...sessionAttrs,
				},
			}, trace.setSpan(context.active(), turnSpan));
			toolSpans.set(event.toolCallId, span);
		} catch (e) { console.error("[pi-phoenix]", e); }
		return undefined;
	});

	pi.on("tool_execution_end", async (event) => {
		const span = toolSpans.get(event.toolCallId);
		if (!span) return undefined;
		try {
			const r: any = (event as any).result;
			const outText = readText(r?.content ?? r);
			if (outText) {
				span.setAttribute("output.value", clip(outText));
				span.setAttribute("output.mime_type", "text/plain");
			}
			if (event.isError) {
				span.setStatus({ code: SpanStatusCode.ERROR });
				span.setAttribute("error.message", clip(outText || JSON.stringify(r ?? ""), 2000));
			} else {
				span.setStatus({ code: SpanStatusCode.OK });
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
		try { await provider?.forceFlush?.(); } catch { /* ignore */ }
		try { await provider?.shutdown?.(); } catch { /* ignore */ }
		provider = null;
		tracer = null;
		return undefined;
	});

	// Phoenix URL for this session's folder (filtered spans view).
	pi.registerCommand("phoenix-url", {
		description: "Print a Phoenix URL filtered to this session folder",
		handler: async (args, ctx) => {
			const cwd = (args || "").trim() || sessionCwd;
			const url = await sessionUrl(baseUrl, token, cwd);
			console.log(`[pi-phoenix] ${url}`);
			ctx.ui.notify(`[pi-phoenix] ${url}`, "info");
		},
	});

	pi.registerCommand("phoenix-status", {
		description: "Show pi-phoenix tracing target",
		handler: async (_args, ctx) => {
			ctx.ui.notify(`[pi-phoenix] exporting to ${baseUrl} (project: ${PROJECT})`, "info");
		},
	});

	console.log(`[pi-phoenix] tracing → ${baseUrl} (project: ${PROJECT})`);
}