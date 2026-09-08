/**
 * Wraps the exported LlamaCpp class from @tobilu/qmd/dist/llm.js so each of
 * the 3 local GGUF models shows up in Phoenix (project 'qmd') as proper
 * OpenInference spans:
 *
 *   embeddinggemma-300M      -> openinference.span.kind = EMBEDDING
 *   qwen3-reranker-0.6B      -> openinference.span.kind = RERANKER
 *   query-expansion (LFM2)   -> openinference.span.kind = LLM
 *
 * Never throws into qmd: all wrappers fail-open to the original method.
 */
import { trace, SpanStatusCode } from "@opentelemetry/api";

const TRACER_NAME = "qmd-trace";
const MAX_TEXT = 600;

function cut(s, n = MAX_TEXT) {
  if (s === undefined || s === null) return undefined;
  s = String(s);
  return s.length > n ? s.slice(0, n) + `…(+${s.length - n} chars)` : s;
}

let installed = false;

export function installQmdTrace(LlamaCpp) {
  if (installed || !LlamaCpp?.prototype) {
    if (installed) console.log("[qmd-trace] already installed");
    else console.error("[qmd-trace] LlamaCpp class missing — skip");
    return;
  }
  installed = true;
  const proto = LlamaCpp.prototype;

  const projectAttr = () => ({
    "openinference.project.name": process.env.QMD_TRACE_PROJECT ?? "qmd",
  });

  /**
   * Generic async method wrapper.
   * spanName: name; kind: openinference.span.kind; buildAttrs: (args, result) => attrs
   */
  function wrap(methodName, spanName, oiKind, buildAttrs) {
    const original = proto[methodName];
    if (typeof original !== "function") {
      console.error(`[qmd-trace] method ${methodName} not found on LlamaCpp — skip`);
      return;
    }
    proto[methodName] = async function (...args) {
      const tracer = trace.getTracer(TRACER_NAME);
      // No recorder (tracing off) -> cheap passthrough path still goes through
      // startActiveSpan, which is a no-op wrapper when non-recording.
      return tracer.startActiveSpan(spanName, async (span) => {
        const t0 = Date.now();
        try {
          const result = await original.apply(this, args);
          try {
            span.setAttributes({
              "openinference.span.kind": oiKind,
              ...projectAttr(),
              "qmd.method": methodName,
              "qmd.duration_ms": Date.now() - t0,
              ...(buildAttrs ? buildAttrs(args, result) : {}),
            });
            span.setStatus({ code: SpanStatusCode.OK });
          } catch {
            /* attr failures must never break qmd */
          }
          span.end();
          return result;
        } catch (err) {
          try {
            span.setStatus({
              code: SpanStatusCode.ERROR,
              message: String(err?.message ?? err),
            });
            span.recordException(err);
            span.setAttributes({
              "openinference.span.kind": oiKind,
              ...projectAttr(),
              "qmd.method": methodName,
            });
          } catch {
            /* noop */
          }
          span.end();
          throw err;
        }
      });
    };
  }

  // ---------------------------------------------------------------- EMBEDDING
  wrap("embed", "qmd.embed", "EMBEDDING", ([text], result) => ({
    "embedding.model_name": result?.model ?? "?",
    "embedding.embeddings.0.embedding.text": cut(text),
    "qmd.text_length": text?.length ?? 0,
    "qmd.embedding_dim": Array.isArray(result?.embedding) ? result.embedding.length : undefined,
  }));

  wrap("embedBatch", "qmd.embed_batch", "EMBEDDING", ([texts], results) => ({
    "embedding.model_name": results?.[0]?.model ?? "?",
    "qmd.batch_size": Array.isArray(texts) ? texts.length : 0,
    "qmd.total_chars": Array.isArray(texts)
      ? texts.reduce((a, t) => a + (t?.length ?? 0), 0)
      : 0,
    "qmd.batch_first_text": cut(Array.isArray(texts) ? texts[0] : ""),
    "qmd.embedded_ok": Array.isArray(results)
      ? results.filter(Boolean).length
      : 0,
  }));

  // -------------------------------------------------------------- RERANKER
  wrap("rerank", "qmd.rerank", "RERANKER", ([query, documents], result) => ({
    "reranking.query": cut(String(query), 300),
    "reranking.model_name": result?.model ?? "?",
    "qmd.documents_count": Array.isArray(documents) ? documents.length : 0,
    "qmd.reranked_count": Array.isArray(result?.results) ? result.results.length : 0,
    "qmd.top_score": Array.isArray(result?.results) && result.results[0]?.score !== undefined
      ? result.results[0].score
      : undefined,
  }));

  // -------------------------------------------------------------------- LLM
  wrap("expandQuery", "qmd.expand_query", "LLM", ([query], result) => ({
    "llm.model_name": result?.model ?? process.env.QMD_GENERATE_MODEL_HINT ?? "query-expansion",
    "llm.prompts.0.content": cut(query, 300),
    "llm.completions.0.content": cut(result ? JSON.stringify(result) : "", 800),
  }));

  wrap("generate", "qmd.generate", "LLM", ([prompt], result) => ({
    "llm.model_name": result?.model ?? "?",
    "llm.prompts.0.content": cut(prompt),
    "llm.completions.0.content": cut(result?.text, 800),
  }));

  console.log("[qmd-trace] LlamaCpp prototype wrapped (embed, embedBatch, rerank, expandQuery, generate)");
}
