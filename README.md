# pi-memory-master

Pi package: **remote QMD memory search + Arize Phoenix tracing** — telefon/notes
zůstávají lehké, veškerý embedding/reranking/tracing běží na Modal serveru (CPU).

## Co obsahuje

| Součást | Popis |
|---|---|
| `extensions/qmd-server.ts` | váže QMD server na životní cyklus pi session (`session_start` → ensure, `quit` → stop) |
| `extensions/pi-phoenix.ts` | OTel tracing: spany `pi.turn` / `llm.call` (tokeny+cost) / `tool.execute` → Phoenix projekt `pi` |
| `bin/qmd-server` | wrapper `start\|stop\|status`; remote mód dle confu, fallback lokální daemon |
| `bin/qmd-shim` | `qmd` CLI shim — překládá `search/vsearch/query` na Modal HTTP; `update/embed` jsou no-op (telefon nic nepočítá) |
| `mcp/qmd-modal-server.mjs` | stdio **MCP server pro pi-mcp** — `deploy` + všechny funkce z `infra.py` (auto-registrace přes `pi.mcp`) |
| `setup.sh` | instalace wrapperu + shimu + MCP serveru + unifikovaného configu (BEZ Modal deploye) |

## pi-mcp (MCP server)

Balíček deklaruje MCP server v `package.json` (`"pi.mcp": "./mcp/qmd-modal.mcp.json"`),
takže se po instalaci **sám zaregistruje** v pi-mcp pod jménem
`pi_memory_master__qmd-modal` (není třeba ručně editovat `~/.config/mcp/mcp.json`).
`setup.sh` instaluje spustitelný launcher `qmd-modal-mcp` (čistý stdlib Node,
žádné npm závislosti).

| Tool | Co dělá |
|---|---|
| `deploy` | `modal deploy infra.py` — nasadí `qmd-mcp` + `phoenix` |
| `status` | poslední běh caretakera (`infra.py::status`) |
| `sync_data` | tar všech `*.md` + `index.yml` → volume → extract |
| `sync_memory` | rychlý sync jen `pi-memory` + rebuild kolekce |
| `reindex` / `embed_batch` / `pull_models` / `rebuild_pi_memory` | odpovídající `infra.py` funkce |
| `diag` / `caretaker` / `check_llm_env` | diagnostika a údržba |
| `health` | probe `qmd-mcp /health` + `phoenix /ping` |
| `search` | vzdálený QMD dotaz (`lex`/`vec`/`hybrid`, `collection`, `limit`, `rerank`) |

Server lokalizuje `qmd-modal/` přes `QMD_MODAL_DIR`, strom balíčku nebo
`/usr/local/share/qmd-modal`; config čte z `~/.local/etc/pi-memory.conf`.

## Instalace

```bash
pi install git:github.com/<user>/pi-memory-master   # nebo lokálně: pi install /cesta/k/repu
cd ~/.pi/agent/git/github.com/<user>/pi-memory-master  # adresář z `pi list`
./setup.sh --key wk-xxx --secret ws-yyy             # Modal Proxy Token
```

Proxy Token: modal.com dashboard → Settings → Proxy Tokens.
Konfig: `~/.local/etc/pi-memory.conf` (setup nikdy nepřepisuje existující;
staré `qmd-server.conf` / `pi-phoenix.conf` umí migrovat).

## Konfigurace

| Soubor | Klíče |
|---|---|
| `~/.local/etc/pi-memory.conf` | `QMD_REMOTE_URL`, `MODAL_KEY`, `MODAL_SECRET`, `PI_PHOENIX_URL`, `PI_PHOENIX_TOKEN` |

Cestu lze přebít `PI_MEMORY_CONF=/path/to/file` (čtou ji obě extenze i
`bin/qmd-server` a `bin/qmd-shim`).

Bez URL/tokenu jsou extenze inertní (žádné errory, žádný provoz).

## Server side (předpoklad)

Modal appka `ai-services`: qmd MCP HTTP + Arize Phoenix za Proxy Token authem.
Infrastruktura: projekt `qmd-modal` (`infra.py` — deploy, sync dat, reindex,
resumable embeddování). Bez ní tahle balíček jen mlčí.

## Poznámky

- Phoenix přijímá **jen OTLP protobuf** (JSON = 415) → `exporter-trace-otlp-proto`
- Projekt ve Phoenixu se řídí atributem `openinference.project.name`
- Shim schyluje `collection list --json` pro health-checky pi-memory pluginu;
  skutečný index/sync se řeší server-side (`sync_memory.sh` po zápisech do paměti)
