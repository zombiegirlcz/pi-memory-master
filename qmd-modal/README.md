# qmd-modal — QMD search + Arize Phoenix na Modalu (CPU)

Všechna těžká práce běží na Modalu (scale-to-zero, žádné GPU náklady), telefon zůstává lehký.

## Endpointy (Modal Proxy Token auth)

| Služba | URL | Auth header |
|---|---|---|
| QMD search | `https://ttdudd7d--qmd-mcp.modal.run` | `Authorization: Bearer <key>.<secret>` |
| Phoenix UI/API/OTLP | `https://ttdudd7d--phoenix.modal.run` | totéž |

Tokeny: `/usr/local/etc/qmd-server.conf` + `/usr/local/etc/pi-phoenix.conf` (chmod 600).
Správa Proxy Tokenů: modal.com dashboard → Settings → Proxy Tokens.

## Architektura

```
telefon ──HTTPS──> Modal edge (proxy auth) ──> kontejner
   │                                            ├─ qmd mcp --http :8182 (CPU, --no-gpu)
   │                                            │    └─ Volume "qmd": /mnt/qmd
   │                                            │         ├─ cache/qmd/  (3× GGUF modely)
   │                                            │         ├─ index/     (index.yml + index.sqlite)
   │                                            │         └─ src/docs_config_memo/ (md zdroje)
   └─ pi tracing (OTLP proto) ──────────────> ├─ phoenix serve :6006
                                                └─ Volume "phoenix-data": /data
```

Kolekce v indexu (3630 docs): docs_config_memo (12), pi-memory (10), pi-hidden (5),
config-hidden (0 — jen node_modules junk), copilot-hidden (31), gemini-brain (3572).

⚠️ qmd **nikdy neindexuje tečkové adresáře** (`dot:false` + hidden filter) — proto
kolekce míří PŘÍMO do skrytých podstromů (stejný trik jako pi-memory).

## Pi integrace

- `~/.pi/agent/extensions/qmd-server.ts` — **nezměněno**; volá `qmd-server start/stop`
- `/usr/local/bin/qmd-server` — nový wrapper; s `QMD_REMOTE_URL` v confu funguje remote mód
  (`start` neblokuje, cold start polluje na pozadí do /tmp/qmd-server-remote.log)
- `~/.pi/agent/extensions/pi-phoenix/` — OTel tracing → projekt `pi` ve Phoenixu
  (spans: pi.turn / llm.call / tool.execute; OTLP **proto** — Phoenix JSON odmítá 415!)

## Tracing qmd → projekt `qmd` ve Phoenixu

Phoenix projekt **`qmd`** zobrazuje práci qmd serveru i jeho 3 lokálních GGUF modelů:

| Model | Span (openinference.span.kind) | Kdy |
|---|---|---|
| embeddinggemma-300M | `qmd.embed` / `qmd.embed_batch` (**EMBEDDING**) | vec search, indexace, embed dávky |
| qwen3-reranker-0.6B | `qmd.rerank` (**RERANKER**) | rerank:true dotazy |
| LFM2-1.2B (expansion) | `qmd.expand_query` / `qmd.generate` (**LLM**) | MCP `query` tool s plain textem |

Jak to funguje:
- **Node loader hook** (`trace/hooks.mjs`, aktivní přes `NODE_OPTIONS=--import`) zachytí
  `@tobilu/qmd/dist/llm.js`, přidá na konec modulu import `trace_llm.mjs` a obalí
  prototyp třídy `LlamaCpp` (embed/embedBatch/rerank/expandQuery/generate).
- Node SDK + HttpInstrumentation exportují OTLP/proto do Phoenixu s bearer authem.
- Python proxy v infra.py vytváří TOOL span (`mcp.tool <name>`) pro každý tools/call /
  REST `/query` a injektuje `traceparent` k upstream requestu.
- Caretaker emituje AGENT span `caretaker.run` + child spans per krok.
- Vypnutí: env `QMD_TRACING=0` (node), `QMD_MCP_TRACING=0` (python). Debug export log:
  `QMD_TRACE_DEBUG=1`.
- ⚠️ Omezení: model spany z CLI subprocessů (caretaker update/embed) jsou samostatné
  traces (bez parent linku přes subprocess hranici); unified chain platí uvnitř jednoho
  node procesu.
- Selftest python exporteru: `modal run test_trace.py` (span `selftest.proxy_span`).

## Operace

```bash
./sync_data.sh                        # tar md souborů + index.yml -> volume + rozbalit
modal run infra.py::reindex           # přescanovat kolekce (rychlé)
modal run infra.py::embed_batch       # embedding dávka (resumable; opakuj dokud PENDING_AFTER > 0)
modal run infra.py::pull_models       # (znovu)stažení GGUF modelů
modal run infra.py::diag              # diagnostika uvnitř kontejneru
modal deploy infra.py                 # redeploy po úpravě infra.py
qmd-server status                     # stav remote serveru
```

## Dotazy (ručně)

```bash
TOK="Authorization: Bearer $(grep MODAL_KEY /usr/local/etc/qmd-server.conf ...)"; # viz conf
curl -X POST -H "$TOK" -H 'Content-Type: application/json' \
  -d '{"searches":[{"type":"lex","query":"..."}],"limit":5,"rerank":false}' \
  https://ttdudd7d--qmd-mcp.modal.run/query
# type: "lex" (BM25) | "vec" (vektor) ; rerank:true = plný hybrid (pomalejší na CPU)
```

## Poznámky / gotchas

- **Trust gate**: index.yml nahraný na volume je "config from checkout" → bez terminálu
  se skipují cesty mimo projekt. Řeší `QMD_TRUST_LOCAL_CONFIG=1` (nastaveno ve funkcích).
- **volume put nepřepisuje** — nejdřív `modal volume rm qmd <path>`.
- Dvě funkce nesmí mít stejný název v jedné appce (kolize → tichý override).
- Phoenix UI v prohlížeči: `?token=<PHOENIX_TOKEN>` nastaví cookie na rok; projekty
  `pi`, `qmd`, `default`. px CLI profil `modal` (`px project list`).
- Embedding ~3.6k dokumentů na CPU trvá hodiny; `embed_batch` je resumable.
