/**
 * ESM load hook: appends a tracing install call to the end of
 * @tobilu/qmd/dist/llm.js so the LlamaCpp class prototype gets wrapped
 * with Phoenix spans for the 3 local GGUF models:
 *
 *   embed / embedBatch -> EMBEDDING   (embeddinggemma-300M)
 *   expandQuery        -> LLM         (qmd-query-expansion-1.7B)
 *   generate           -> LLM         (same generation model)
 *   rerank             -> RERANKER    (qwen3-reranker-0.6B)
 */
export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  try {
    if (
      process.env.QMD_TRACING !== "0" &&
      url.includes("/@tobilu/qmd/") &&
      url.endsWith("/dist/llm.js")
    ) {
      let src =
        typeof result.source === "string"
          ? result.source
          : Buffer.from(result.source).toString("utf8");
      const helperUrl = new URL("./trace_llm.mjs", import.meta.url).href;
      src +=
        `\n;import { installQmdTrace as __qmdTraceInstall } from ${JSON.stringify(helperUrl)};` +
        "\ntry { __qmdTraceInstall(LlamaCpp); } catch (e) { console.error('[qmd-trace] install failed:', e?.message ?? e); }\n";
      return { ...result, source: src };
    }
  } catch {
    /* never break qmd because of tracing */
  }
  return result;
}
