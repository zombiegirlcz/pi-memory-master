/**
 * OTel bootstrap for the qmd container -> Phoenix project 'qmd'.
 *
 * Hand-rolled BasicTracerProvider (same proven pattern as pi-phoenix):
 *  - OTLP/proto exporter with Modal proxy bearer auth
 *  - BatchSpanProcessor + forceFlush on exit (CLI subprocesses are short-lived!)
 *  - HttpInstrumentation for SERVER spans on the MCP HTTP port + traceparent
 */
import api from "@opentelemetry/api";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";

async function pick(spec, name) {
  const m = await import(spec);
  const v = m[name] ?? m.default?.[name];
  if (!v) throw new Error(`${name} not found in ${spec}`);
  return v;
}

const [NodeTracerProvider_, OTLPTraceExporter_, HttpInstrumentation_, registerInstrumentations, resourceFromAttributes] =
  await Promise.all([
    pick("@opentelemetry/sdk-trace-node", "NodeTracerProvider"),
    pick("@opentelemetry/exporter-trace-otlp-proto", "OTLPTraceExporter"),
    pick("@opentelemetry/instrumentation-http", "HttpInstrumentation"),
    pick("@opentelemetry/instrumentation", "registerInstrumentations"),
    pick("@opentelemetry/resources", "resourceFromAttributes"),
  ]);

const url = process.env.PHOENIX_OTLP_URL;
const token = process.env.PHOENIX_TOKEN;
const project = process.env.QMD_TRACE_PROJECT ?? "qmd";

if (!url || !token) {
  console.log("[qmd-trace] PHOENIX_OTLP_URL/PHOENIX_TOKEN not set — tracing off");
} else {
  try {
    const exporter = new OTLPTraceExporter_({
      url,
      headers: { authorization: `Bearer ${token}` },
      timeoutMillis: 120_000, // Modal cold start of Phoenix container can be slow
    });

    const provider = new NodeTracerProvider_({
      resource: resourceFromAttributes({
        "service.name": "qmd",
        "service.namespace": "qmd-modal",
        // Phoenix groups traces into projects by this attribute:
        "openinference.project.name": project,
      }),
      spanProcessors: [new BatchSpanProcessor(exporter, { scheduledDelayMillis: 5000 })],
    });
    provider.register();

    registerInstrumentations({
      instrumentations: [
        new HttpInstrumentation_(), // SERVER spans per MCP HTTP call; reads traceparent
      ],
    });

    // Short-lived CLI processes (qmd update/embed/status) exit fast — flush!
    const flushAndLog = async (why) => {
      try {
        await provider.forceFlush();
        if (why) console.log(`[qmd-trace] flushed (${why})`);
      } catch (e) {
        console.error("[qmd-trace] flush failed:", e?.message ?? e);
      }
    };
    const t0 = Date.now();
    let lastFlush = 0;
    process.on("beforeExit", () => {
      // beforeExit may fire repeatedly; throttle to once per 10s
      if (Date.now() - lastFlush < 10_000) return;
      lastFlush = Date.now();
      flushAndLog("beforeExit");
    });
    for (const sig of ["SIGTERM", "SIGINT"]) {
      process.on(sig, () => {
        flushAndLog(sig);
        // give the export up to 3s, then hard-exit so container stops cleanly
        setTimeout(() => process.exit(0), 3000).unref();
      });
    }
    console.log(
      `[qmd-trace] OTel ready -> ${url} (project: ${project}) in ${Date.now() - t0}ms`
    );
  } catch (e) {
    console.error("[qmd-trace] init failed:", e?.message ?? e);
  }
}
