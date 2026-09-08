"""
QMD (search) + Arize Phoenix (tracing) — CPU-only Modal deployment.

Apps:
  qmd-server  — qmd MCP/HTTP server behind bearer-auth proxy
                functions: serve | pull_models | sync_data | reindex
  phoenix     — Arize Phoenix UI+REST+OTLP-HTTP behind bearer-auth proxy
                functions: serve

Volumes:
  qmd          /mnt/qmd  {cache/qmd=models, index=sqlite+yml, src/docs_config_memo}
  phoenix-data /data     (phoenix working dir: sqlite db, sessions)

Local layout inside containers mirrors the phone so the uploaded index.sqlite
resolves identical absolute paths:
  /root/.cache            -> /mnt/qmd/cache        (GGUF models)
  /root/.qmd              -> /mnt/qmd/index        (index.yml + index.sqlite)
  /root/docs_config_memo  -> /mnt/qmd/src/docs_config_memo

Deploy:   modal deploy infra.py
Models:   modal run infra.py::pull_models
Data sync (from phone): ./sync_data.sh   (tars md files + puts on volume)
Reindex:  modal run infra.py::reindex
"""

import modal

# Phoenix OTLP endpoint (project routing via openinference.project.name attr)
PHOENIX_OTLP_URL = "https://ttdudd7d--phoenix.modal.run/v1/traces"
TRACE_FILES = ["hooks.mjs", "loader.mjs", "setup.mjs", "trace_llm.mjs"]

# ------------------------------------------------------------- py tracer ----

def _init_py_tracer(service_name: str, project: str = "qmd"):
    """Python-side OTel provider -> Phoenix (OTLP/proto, bearer auth).
    Returns a tracer or None (when unconfigured/disabled)."""
    import atexit
    import os

    if os.environ.get("QMD_MCP_TRACING", "1") == "0":
        return None
    url = os.environ.get("PHOENIX_OTLP_URL") or PHOENIX_OTLP_URL
    tok = os.environ.get("PHOENIX_TOKEN")
    if not tok:
        return None
    try:
        from opentelemetry import trace  # noqa: F401 (explicitní závislost)
        from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
        from opentelemetry.sdk.resources import Resource
        from opentelemetry.sdk.trace import TracerProvider
        # Simple = synchronní export ihned po span.end(). U ASGI funkcí se
        # BatchSpanProcessor background thread ukázal nespolehlivý.
        from opentelemetry.sdk.trace.export import SimpleSpanProcessor

        provider = TracerProvider(
            resource=Resource.create({
                "service.name": service_name,
                "service.namespace": "qmd-modal",
                "openinference.project.name": project,
            })
        )

        exporter = OTLPSpanExporter(
            endpoint=url,
            headers={"authorization": f"Bearer {tok}"},
            timeout=120,  # Modal cold start
        )

        if os.environ.get("QMD_TRACE_DEBUG") == "1":
            class _LoggingExporter:
                def __init__(self, inner):
                    self._inner = inner

                def export(self, spans):
                    try:
                        r = self._inner.export(spans)
                        print(f"[qmd-proxy-trace] export {len(spans)} spans -> {r.name}", flush=True)
                        return r
                    except Exception as e:
                        print(f"[qmd-proxy-trace] EXPORT FAIL: {e}", flush=True)
                        raise

                def shutdown(self):
                    return self._inner.shutdown()

                def force_flush(self, timeout_millis=None):
                    return self._inner.force_flush(timeout_millis)

            exporter = _LoggingExporter(exporter)

        provider.add_span_processor(SimpleSpanProcessor(exporter))
        atexit.register(lambda: provider.force_flush())

        # POZOR: nespoléhej na globální registry — trace.set_tracer_provider()
        # je no-op, pokud už v procesu provider existuje (např. od Modal
        # runtime) a spany pak padají do nerecording providera. Bindni tracer
        # PŘÍMO na naši instanci (stejná lekce jako u pi-phoenix extenze).
        return provider.get_tracer(service_name)
    except Exception as e:  # tracing must never break the app
        print(f"[qmd-trace-py] init failed: {e}")
        return None

# ---------------------------------------------------------------- images ----

qmd_image = (
    modal.Image.debian_slim(python_version="3.12")
    .apt_install("curl", "ca-certificates", "xz-utils", "python3", "make", "g++")
    .run_commands(
        "curl -fsSL https://deb.nodesource.com/setup_22.x | bash -",
        "apt-get install -y nodejs",
        "npm install -g @tobilu/qmd@2.8.3",
    )
    .pip_install(
        "fastapi", "httpx", "uvicorn",
        # python-side OTel (proxy + caretaker spans)
        "opentelemetry-api", "opentelemetry-sdk",
        "opentelemetry-exporter-otlp-proto-http",
    )
    # qmd-trace: Node loader hooks wrapping qmd's 3 GGUF models into
    # EMBEDDING/RERANKER/LLM spans exported to Phoenix project 'qmd'
    # (copy=True -> files baked into the image so npm install can run on them)
    .add_local_file("/root/qmd-modal/trace/package.json", "/opt/qmd-trace/package.json", copy=True)
    .add_local_file("/root/qmd-modal/trace/hooks.mjs", "/opt/qmd-trace/hooks.mjs", copy=True)
    .add_local_file("/root/qmd-modal/trace/loader.mjs", "/opt/qmd-trace/loader.mjs", copy=True)
    .add_local_file("/root/qmd-modal/trace/setup.mjs", "/opt/qmd-trace/setup.mjs", copy=True)
    .add_local_file("/root/qmd-modal/trace/trace_llm.mjs", "/opt/qmd-trace/trace_llm.mjs", copy=True)
    .run_commands("cd /opt/qmd-trace && npm install --omit=dev --no-audit --no-fund")
    # NODE_OPTIONS AFTER build-time npm steps so image builds stay clean;
    # hooks stay inert unless PHOENIX_TOKEN is present in the function env.
    .env({
        "NODE_OPTIONS": "--import /opt/qmd-trace/hooks.mjs",
        "PHOENIX_OTLP_URL": PHOENIX_OTLP_URL,
    })
)

phoenix_image = (
    modal.Image.debian_slim(python_version="3.12")
    .pip_install(
        "arize-phoenix==20.3.0",
        "fastapi",
        "httpx",
        "uvicorn",
    )
)

# --------------------------------------------------------------- volumes ----

qmd_vol = modal.Volume.from_name("qmd", create_if_missing=True)
phoenix_vol = modal.Volume.from_name("phoenix-data", create_if_missing=True)

# ------------------------------------------------------------ entrypoint ----

QMD_ENTRY = r"""#!/bin/bash
set -euo pipefail
mkdir -p /mnt/qmd/cache/qmd /mnt/qmd/index /mnt/qmd/src
rm -rf /root/.cache /root/.qmd /root/docs_config_memo
ln -sfn /mnt/qmd/cache /root/.cache
ln -sfn /mnt/qmd/index /root/.qmd
ln -sfn /mnt/qmd/src/docs_config_memo /root/docs_config_memo
if [ ! -f /root/.qmd/index.yml ]; then
  echo '{"error":"index.yml missing — run sync_data"}' >&2
fi
export QMD_FORCE_CPU=1
exec qmd mcp --http --host 127.0.0.1 --port 8182 --no-gpu
"""

PHOENIX_ENTRY = r"""#!/bin/bash
set -euo pipefail
mkdir -p /data
export PHOENIX_WORKING_DIR=/data
export PHOENIX_PORT=6006
export PHOENIX_GRPC_PORT=4317
# keep footprint small on CPU box
export PHOENIX_DISABLE_RATE_LIMIT=true
exec phoenix serve --host 127.0.0.1 --port 6006
"""

# --------------------------------------------------------- auth proxy app ----


def make_proxy_app(upstream_port: int, mode: str = "edge"):
    """Reverse proxy. mode='edge': Modal enforces Proxy-Token (no local check).
    mode='cookie': this app checks Authorization/cookie/?token= itself —
    browser-friendly (?token=... sets HttpOnly cookie, then UI just works)."""
    from contextlib import asynccontextmanager

    from fastapi import FastAPI, Request, Response
    import httpx
    import os
    import subprocess
    import time

    entry = (
        QMD_ENTRY if upstream_port == 8182 else PHOENIX_ENTRY
    )

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        proc = subprocess.Popen(["bash", "-c", entry])
        # qmd proxy: python-side OTel -> Phoenix project 'qmd' (inert without secret)
        app.state.tracer = _init_py_tracer("qmd-proxy") if upstream_port == 8182 else None
        print(f"[qmd-proxy] up on :{upstream_port} mode={mode} tracer={'yes' if getattr(app.state, 'tracer', None) else 'no'} (rev 3)", flush=True)
        base = f"http://127.0.0.1:{upstream_port}"
        for _ in range(120):  # up to ~60s for cold boot
            try:
                async with httpx.AsyncClient() as c:
                    await c.get(f"{base}/")
                break
            except Exception:
                time.sleep(0.5)
        yield
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except Exception:
            proc.kill()

    web = FastAPI(lifespan=lifespan)

    methods = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"]

    def _parse_tool_call(path: str, body: bytes):
        """Return {'tool':..., 'args': {...}} for traced qmd calls, else None.
        Handles both MCP JSON-RPC (POST /mcp) and REST search (POST /query|/search)."""
        import json as _json

        try:
            if body[:1] != b"{":
                return None
            payload = _json.loads(body)
            # NOTE: catchall route passes path WITHOUT leading slash ("query")
            norm = "/" + (path or "").lstrip("/")
            if norm.rstrip("/").endswith("/mcp"):
                if payload.get("method") != "tools/call":
                    return None
                params = payload.get("params") or {}
                return {
                    "tool": str(params.get("name") or "?"),
                    "args": params.get("arguments") or {},
                }
            if norm.rstrip("/").endswith(("/query", "/search")):
                return {
                    "tool": "query",
                    "args": {
                        "searches": payload.get("searches") or [],
                        "query": payload.get("query"),
                        "limit": payload.get("limit"),
                        "rerank": payload.get("rerank"),
                        "collections": payload.get("collections"),
                        "intent": payload.get("intent"),
                    },
                }
        except Exception:
            return None
        return None

    async def _proxy(request: Request, path: str) -> Response:
        # NOTE: imports here — they must exist on EVERY code path (the else
        # branch uses nullcontext; a branch-local import would make it an
        # unbound local for non-tool calls and 500 every request)
        from contextlib import nullcontext

        from opentelemetry.propagate import inject as otel_inject
        from opentelemetry.trace import SpanKind, StatusCode

        if mode == "cookie":
            tok = os.environ.get("PROXY_TOKEN", "")
            auth = request.headers.get("authorization", "")
            ck = request.cookies.get("proxy_token", "")
            qt = request.query_params.get("token", "")
            authorized = bool(tok) and (
                auth == f"Bearer {tok}" or ck == tok or (qt != "" and qt == tok)
            )
            # Debug logging - pouze při QMD_TRACE_DEBUG=1
            if os.environ.get("QMD_TRACE_DEBUG") == "1" and not authorized:
                print(f"[qmd-proxy-debug] auth FAIL: tok_set={bool(tok)} auth_header={auth[:30]!r} ck={ck[:20]!r} qt={qt[:20]!r}", flush=True)

            if not authorized:
                return Response(
                    '<h1>401</h1><p>Přihlas se: <code>?token=&lt;PHOENIX_TOKEN&gt;</code></p>',
                    status_code=401, media_type="text/html",
                )
        body = await request.body()
        headers = {
            k: v
            for k, v in request.headers.items()
            if k.lower()
            in ("content-type", "accept", "accept-language", "user-agent", "origin", "referer", "authorization")
        }

        tracer = getattr(web.state, "tracer", None)
        mcp = (
            _parse_tool_call(path, body)
            if (mode == "edge" and request.method == "POST" and tracer is not None)
            else None
        )

        if mcp is not None:
            # ---- traced MCP tool call: TOOL span + traceparent -> Node SERVER span
            tool, args_ = mcp["tool"], mcp["args"]
            attrs = {
                "openinference.span.kind": "TOOL",
                "openinference.project.name": "qmd",
                "mcp.tool.name": tool,
            }
            for key in ("query", "intent"):
                if isinstance(args_.get(key), str):
                    attrs[f"qmd.arg.{key}"] = args_[key][:300]
            for key in ("limit", "candidateLimit", "rerank", "minScore"):
                if args_.get(key) is not None:
                    attrs[f"qmd.arg.{key}"] = args_[key]
            if isinstance(args_.get("collections"), list):
                attrs["qmd.arg.collections"] = ",".join(args_["collections"])[:200]
            if isinstance(args_.get("searches"), list):
                attrs["qmd.arg.subqueries"] = ",".join(
                    str(s.get("type")) for s in args_["searches"]
                )[:200]

            span_cm = tracer.start_as_current_span(
                f"mcp.tool {tool}", kind=SpanKind.SERVER, attributes=attrs
            )
        else:
            span_cm = nullcontext()

        with span_cm as span:
            if span is not None:
                otel_inject(headers)  # traceparent -> Node http instrumentation
            url = f"http://127.0.0.1:{upstream_port}/{path}"
            if request.url.query:
                url += f"?{request.url.query}"
            async with httpx.AsyncClient(timeout=httpx.Timeout(300.0)) as client:
                resp = await client.request(
                    request.method, url, content=body, headers=headers
                )
            if span is not None:
                try:
                    import json as _json

                    result = _json.loads(resp.content)
                    results_list = (
                        (result.get("structuredContent") or {}).get("results")
                        or result.get("results")
                        or []
                    )
                    span.set_attribute("qmd.result_count", len(results_list))
                    span.set_attribute("qmd.is_error", bool(result.get("isError")))
                    if resp.status_code >= 500:
                        span.set_status(StatusCode.ERROR)
                except Exception:
                    pass
            resp_headers = {
                k: v
                for k, v in resp.headers.items()
                if k.lower() in ("content-type",)
            }
            response = Response(resp.content, status_code=resp.status_code,
                                headers=resp_headers)
            if mode == "cookie" and request.query_params.get("token", ""):
                response.set_cookie("proxy_token",
                                    request.query_params["token"],
                                    httponly=True, samesite="lax", max_age=31536000)
            return response

    @web.api_route("/", methods=methods)
    async def root(request: Request) -> Response:
        return await _proxy(request, "")

    @web.api_route("/{path:path}", methods=methods)
    async def catchall(request: Request, path: str) -> Response:
        return await _proxy(request, path)

    @web.get("/ping")
    async def ping(request: Request) -> Response:
        return Response(content="pong", status_code=200, media_type="text/plain")

    return web


# ============================================================== qmd app =====

app = modal.App("ai-services")


@app.function(
    image=qmd_image,
    volumes={"/mnt/qmd": qmd_vol},
    cpu=4.0,
    memory=8192,
    timeout=3600,
    scaledown_window=300,
    secrets=[modal.Secret.from_name("phoenix-auth")],  # PHOENIX_TOKEN -> tracing
)
@modal.asgi_app(label="qmd-mcp")
def qmd_serve():
    import os
    os.environ.setdefault("PROXY_TOKEN", os.environ.get("PHOENIX_TOKEN", ""))
    return make_proxy_app(8182, mode="cookie")


@app.function(
    image=qmd_image,
    volumes={"/mnt/qmd": qmd_vol},
    cpu=4.0,
    timeout=3600,
)
def pull_models():
    """Download all three GGUF models into the volume cache."""
    import subprocess, os

    os.makedirs("/mnt/qmd/cache/qmd", exist_ok=True)
    subprocess.run(
        ["bash", "-c", QMD_SETUP_LINKS], check=True
    )
    r = subprocess.run(["qmd", "pull"])
    assert r.returncode == 0, "qmd pull failed"
    d = subprocess.run(["qmd", "doctor"], capture_output=True, text=True)
    print(d.stdout[-2000:])
    qmd_vol.commit()


QMD_SETUP_LINKS = r"""
mkdir -p /mnt/qmd/cache/qmd /mnt/qmd/index /mnt/qmd/src
rm -rf /root/.cache /root/.qmd
ln -sfn /mnt/qmd/cache /root/.cache
ln -sfn /mnt/qmd/index /root/.qmd
"""


@app.function(
    image=qmd_image,
    volumes={"/mnt/qmd": qmd_vol},
    cpu=2.0,
    timeout=1800,
)
def sync_data():
    """Extract uploaded src.tar into place; commit volume."""
    import subprocess, tarfile, os

    os.makedirs("/mnt/qmd/src/docs_config_memo", exist_ok=True)
    with tarfile.open("/mnt/qmd/src.tar") as t:
        t.extractall("/mnt/qmd/src/docs_config_memo")
    # tar preserves old mtimes -> qmd would skip files as "unchanged"; force fresh mtimes
    subprocess.run(["bash", "-c",
        "find /mnt/qmd/src/docs_config_memo -type f -exec touch {} +"], check=True)
    n = sum(len(f) for _, _, f in os.walk("/mnt/qmd/src/docs_config_memo"))
    print(f"extracted files: {n}")
    qmd_vol.commit()


@app.function(
    image=qmd_image,
    volumes={"/mnt/qmd": qmd_vol},
    cpu=4.0,
    memory=8192,
    timeout=3 * 3600,
    env={"QMD_TRUST_LOCAL_CONFIG": "1"},
)
def reindex():
    """Re-scan all collections into the index (no embeddings)."""
    import subprocess

    subprocess.run(["bash", "-c", QMD_SETUP_LINKS], check=True)
    subprocess.run(["bash", "-c",
        "ln -sfn /mnt/qmd/src/docs_config_memo /root/docs_config_memo"], check=True)
    print("+ qmd update")
    r = subprocess.run(["qmd", "update"])
    assert r.returncode == 0, "qmd update failed"
    s = subprocess.run(["qmd", "status"], capture_output=True, text=True)
    print(s.stdout[-1500:])
    qmd_vol.commit()


@app.function(
    image=qmd_image,
    volumes={"/mnt/qmd": qmd_vol},
    cpu=8.0,
    memory=8192,
    timeout=3 * 3600,
    env={"QMD_TRUST_LOCAL_CONFIG": "1", "QMD_FORCE_CPU": "1"},
)
def embed_batch():
    """Embed pending documents (resumable — run repeatedly until done)."""
    import subprocess, re

    subprocess.run(["bash", "-c", QMD_SETUP_LINKS], check=True)
    r = subprocess.run(["qmd", "embed"], capture_output=True, text=True)
    print(r.stdout[-2000:], r.stderr[-500:])
    assert r.returncode == 0, "qmd embed failed"
    s = subprocess.run(["qmd", "status"], capture_output=True, text=True)
    out = s.stdout
    print(out[-1200:])
    m = re.search(r"Pending:\s*(\d+)", out)
    pending = int(m.group(1)) if m else -1
    print("PENDING_AFTER:", pending)
    qmd_vol.commit()
    return {"pending_after": pending}


# ========================================================== phoenix app =====

@app.function(
    image=phoenix_image,
    volumes={"/data": phoenix_vol},
    secrets=[
        modal.Secret.from_name("phoenix-auth"),
        modal.Secret.from_name("phoenix-llm"),  # OPENAI_API_KEY + OPENAI_BASE_URL -> opencode zen (playground/assistant)
    ],
    cpu=2.0,
    memory=4096,
    timeout=3600,
    scaledown_window=600,
)
@modal.asgi_app(label="phoenix")
def phoenix_serve():
    import os
    os.environ["PROXY_TOKEN"] = os.environ["PHOENIX_TOKEN"]
    return make_proxy_app(6006, mode="cookie")


@app.function(
    image=qmd_image,
    volumes={"/mnt/qmd": qmd_vol},
    cpu=2.0,
    timeout=600,
    env={"QMD_TRUST_LOCAL_CONFIG": "1"},
)
def diag():
    import subprocess, os, sqlite3, json

    subprocess.run(["bash", "-c", QMD_SETUP_LINKS], check=True)
    subprocess.run(["bash", "-c",
        "ln -sfn /mnt/qmd/src/docs_config_memo /root/docs_config_memo"], check=True)

    # 1) glob test replicating qmd's exact fast-glob call
    nm = "/usr/local/lib/node_modules/@tobilu/qmd/node_modules"
    print("node_modules exists:", os.path.isdir(nm))
    with open("/tmp/globtest.cjs", "w") as f:
        f.write("const fg=require('fast-glob');"
                "process.chdir('/mnt/qmd/src/docs_config_memo');"
                "const r=fg.sync('**/*.md',{dot:false,followSymbolicLinks:false});"
                "console.log('glob dot:false:',r.length);"
                "console.log(r.slice(0,10).join('\n'));")
    r = subprocess.run(["node", "/tmp/globtest.cjs"],
                       capture_output=True, text=True,
                       env={**os.environ, "NODE_PATH": nm})
    print(r.stdout, r.stderr[:300])

    r2 = subprocess.run(["bash", "-c",
        "grep -c exporter-trace-otlp-proto /mnt/qmd/src/docs_config_memo/.pi/agent/memory/MEMORY.md || echo MISSING; "
        "sha256sum /mnt/qmd/src/docs_config_memo/.pi/agent/memory/MEMORY.md | cut -c1-16; "
        "stat -c %Y /mnt/qmd/src/docs_config_memo/.pi/agent/memory/MEMORY.md"], capture_output=True, text=True)
    print("remote file [has-proto, sha16, mtime]:", r2.stdout.split())
    import hashlib
    con2 = sqlite3.connect("/mnt/qmd/index/index.sqlite")
    try:
        cols = [r[1] for r in con2.execute("PRAGMA table_info(documents)")]
        row = con2.execute("SELECT id, path, hash FROM documents WHERE collection='pi-memory' AND path LIKE '%MEMORY.md'").fetchall()
        print("db rows:", row)
        # content table lookup
        ccols = [r[1] for r in con2.execute("PRAGMA table_info(content)")]
        print("content cols:", ccols)
        if row:
            cid = row[0][0]
            cr = con2.execute("SELECT * FROM content WHERE id=? OR hash=? LIMIT 1", (cid, row[0][2])).fetchone()
            if cr:
                blob = str(cr[-1])
                print("db content len:", len(blob), "| has proto:", "exporter-trace-otlp-proto" in blob)
    finally:
        con2.close()

    # 2) db state
    con = sqlite3.connect("/mnt/qmd/index/index.sqlite")
    try:
        rows = con.execute("SELECT name, pwd, glob_pattern FROM store_collections").fetchall()
        print("collections:", json.dumps(rows))
        rows = con.execute(
            "SELECT collection || ':' || path FROM documents ORDER BY collection, path LIMIT 30"
        ).fetchall()
        print("docs:")
        for (p,) in rows:
            print("  ", p)
    finally:
        con.close()


@app.function(
    image=qmd_image,
    volumes={"/mnt/qmd": qmd_vol},
    cpu=2.0,
    timeout=1800,
    env={"QMD_TRUST_LOCAL_CONFIG": "1"},
)
def rebuild_pi_memory():
    """pi-memory kolekce: smazat a postavit znovu (opraví FTS u změněných docs)."""
    import subprocess
    subprocess.run(["bash", "-c", QMD_SETUP_LINKS], check=True)
    subprocess.run(["bash", "-c",
        "ln -sfn /mnt/qmd/src/docs_config_memo /root/docs_config_memo"], check=True)
    subprocess.run(["bash", "-c", "cd /root && qmd collection remove pi-memory"], check=False)
    r = subprocess.run(["bash", "-c",
        "cd /root && qmd collection add /root/docs_config_memo/.pi/agent/memory --name pi-memory"],
        capture_output=True, text=True)
    print(r.stdout[-400:], r.stderr[-200:])
    r = subprocess.run(["bash", "-c", "cd /root && qmd update"], capture_output=True, text=True)
    out = r.stdout
    i = out.find("pi-memory")
    print(out[max(0,i-100):i+200])
    assert r.returncode == 0
    qmd_vol.commit()


# ========================================================== caretaker =======

@app.function(
    image=qmd_image,
    volumes={"/mnt/qmd": qmd_vol},
    cpu=4.0,
    memory=8192,
    timeout=3600,
    env={"QMD_TRUST_LOCAL_CONFIG": "1", "QMD_FORCE_CPU": "1"},
    schedule=modal.Cron("*/20 * * * *"),  # každých 20 minut
    secrets=[modal.Secret.from_name("phoenix-auth")],  # PHOENIX_TOKEN -> tracing
)
def caretaker():
    """Správce serveru — běží periodicky na Modalu:
      1. rebuild pi-memory kolekce (fix FTS u změněných dokumentů)
      2. qmd update            (zaindexuje nově nahrané soubory)
      3. qmd embed smyčka      (dokud pending>0, max ~25 min za běh; resumable)
      4. zapíše /mnt/qmd/status.json (poslední běh, pending, ts)
    Kontejnery Modal se obnovují samy per-request; tato funkce drží data
    čerstvá a hlásí stav. Nové SOUBORY z telefonu přenáší sync_memory.sh
    (telefonní cron) — caretaker je zpracuje do cca 20 minut.
    """
    import subprocess, json, time
    from contextlib import nullcontext

    from opentelemetry.trace import SpanKind, get_current_span

    tracer = _init_py_tracer("qmd-caretaker")

    def step_span(name):
        if tracer is None:
            return nullcontext()
        return tracer.start_as_current_span(name, kind=SpanKind.INTERNAL)

    def run(cmd, timeout=None):
        return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)

    subprocess.run(["bash", "-c", QMD_SETUP_LINKS], check=True)
    subprocess.run(["bash", "-c",
        "ln -sfn /mnt/qmd/src/docs_config_memo /root/docs_config_memo"], check=True)

    started = time.time()
    log = []

    root_cm = (
        tracer.start_as_current_span(
            "caretaker.run", kind=SpanKind.INTERNAL,
            attributes={"openinference.span.kind": "AGENT"})
        if tracer is not None else nullcontext()
    )
    with root_cm:
        try:
            # 1) pi-memory FTS rebuild (levné, ~31 docs)
            with step_span("caretaker.rebuild_pi_memory"):
                r = run(["bash", "-c",
                    "cd /root && qmd collection remove pi-memory 2>/dev/null;"
                    "qmd collection add /root/docs_config_memo/.pi/agent/memory --name pi-memory"])
                get_current_span().set_attribute("caretaker.rc", r.returncode)
            log.append(f"pi-memory rebuild rc={r.returncode}")

            # 2) plný update
            with step_span("caretaker.qmd_update"):
                r = run(["qmd", "update"], timeout=900)
                get_current_span().set_attribute("caretaker.rc", r.returncode)
            log.append(f"update rc={r.returncode}")
        except Exception as e:
            log.append(f"update/rebuild error: {e}")

        # 3) embed smyčka s časovým rozpočtem (zbytek času pod 25 min)
        pending = -1
        with step_span("caretaker.embed_loop"):
            try:
                while time.time() - started < 1500:
                    s = run(["qmd", "status"], timeout=120).stdout
                    import re as _re
                    m = _re.search(r"Pending:\s*(\d+)", s)
                    pending = int(m.group(1)) if m else -1
                    if pending <= 0:
                        break
                    run(["qmd", "embed"], timeout=1400)
                    s = run(["qmd", "status"], timeout=120).stdout
                    m = _re.search(r"Pending:\s*(\d+)", s)
                    try:
                        pending = int(m.group(1))
                    except Exception:
                        break
            except Exception as e:
                log.append(f"embed loop error: {e}")
            get_current_span().set_attribute("caretaker.pending_after", pending)

    # 4) status.json na volume
    status = {
        "ts": int(time.time()),
        "runtime_s": round(time.time() - started),
        "pending_after": pending,
        "log": log,
    }
    with open("/mnt/qmd/status.json", "w") as f:
        json.dump(status, f)
    qmd_vol.commit()
    print("CARETAKER:", json.dumps(status))


@app.function(
    image=qmd_image,
    volumes={"/mnt/qmd": qmd_vol},
    cpu=1.0,
    timeout=300,
)
def status():
    """Lokální pohled: modal run infra.py::status → poslední caretaker běh."""
    import json, time, os
    p = "/mnt/qmd/status.json"
    if not os.path.exists(p):
        print("status.json: zatím žádný běh caretakera")
        return
    s = json.load(open(p))
    age_min = round((time.time() - s["ts"]) / 60)
    print(f"poslední běh: před {age_min} min | pending embeddings: {s.get('pending_after')}")
    for line in s.get("log", []):
        print("  ", line)


@app.function(
    image=phoenix_image,
    secrets=[modal.Secret.from_name("phoenix-llm")],
    timeout=120,
)
def check_llm_env():
    import os
    k = os.environ.get("OPENAI_API_KEY", "")
    b = os.environ.get("OPENAI_BASE_URL", "")
    print(f"OPENAI_API_KEY: {'set ('+str(len(k))+' znaků)' if k else 'CHYBÍ'}")
    print(f"OPENAI_BASE_URL: {b or 'CHYBÍ'}")
    # živý test proti opencode
    import httpx
    try:
        r = httpx.post(
            f"{b.rstrip('/')}/chat/completions",
            headers={"Authorization": f"Bearer {k}"},
            json={"model": "x-preview-f-free",
                  "messages": [{"role": "user", "content": "Reply exactly: PING"}],
                  "max_tokens": 10},
            timeout=60,
        )
        print("opencode test:", r.status_code, r.json().get("choices", [{}])[0].get("message", {}).get("content", "")[:50])
    except Exception as e:
        print("opencode test FAIL:", e)
