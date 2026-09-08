/**
 * qmd-trace entry — loaded via NODE_OPTIONS="--import /opt/qmd-trace/hooks.mjs"
 *
 * 1. registers ESM loader hook that patches @tobilu/qmd/dist/llm.js
 * 2. starts the OTel SDK (export -> Phoenix, project 'qmd')
 *
 * Inert when: PHOENIX_OTLP_URL / PHOENIX_TOKEN missing, or QMD_TRACING=0.
 */
if (process.env.QMD_TRACING !== "0") {
  const configured = process.env.PHOENIX_OTLP_URL && process.env.PHOENIX_TOKEN;
  if (configured) {
    const { register } = await import("node:module");
    register(new URL("./loader.mjs", import.meta.url));
    await import(new URL("./setup.mjs", import.meta.url));
  }
}
