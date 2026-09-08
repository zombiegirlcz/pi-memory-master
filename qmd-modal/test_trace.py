"""Selftest: python-side OTel -> Phoenix. Spusť: modal run test_trace.py"""
import modal

app = modal.App("qmd-trace-selftest")

qmd_image = (
    modal.Image.debian_slim(python_version="3.12")
    .pip_install(
        "fastapi", "httpx", "uvicorn",
        "opentelemetry-api", "opentelemetry-sdk",
        "opentelemetry-exporter-otlp-proto-http",
    )
)
PHOENIX_OTLP_URL = "https://ttdudd7d--phoenix.modal.run/v1/traces"


def _init_py_tracer(service_name: str, project: str = "qmd"):
    import atexit
    import os

    if os.environ.get("QMD_MCP_TRACING", "1") == "0":
        return None
    url = os.environ.get("PHOENIX_OTLP_URL") or PHOENIX_OTLP_URL
    tok = os.environ.get("PHOENIX_TOKEN")
    if not tok:
        return None
    try:
        from opentelemetry import trace
        from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
        from opentelemetry.sdk.resources import Resource
        from opentelemetry.sdk.trace import TracerProvider
        from opentelemetry.sdk.trace.export import BatchSpanProcessor

        provider = TracerProvider(
            resource=Resource.create({
                "service.name": service_name,
                "openinference.project.name": project,
            })
        )
        provider.add_span_processor(
            BatchSpanProcessor(
                OTLPSpanExporter(
                    endpoint=url,
                    headers={"authorization": f"Bearer {tok}"},
                    timeout=120,
                )
            )
        )
        trace.set_tracer_provider(provider)
        atexit.register(lambda: provider.force_flush())
        return trace.get_tracer(service_name)
    except Exception as e:
        print(f"[selftest-trace] init failed: {e}")
        return None


@app.function(image=qmd_image, secrets=[modal.Secret.from_name("phoenix-auth")], timeout=300)
def run_selftest():
    from opentelemetry import trace

    print("PHOENIX_TOKEN set:", bool(__import__("os").environ.get("PHOENIX_TOKEN")))
    print("PHOENIX_OTLP_URL:", __import__("os").environ.get("PHOENIX_OTLP_URL"))
    tr = _init_py_tracer("qmd-proxy")
    print("tracer:", tr)
    if tr is None:
        return
    with tr.start_as_current_span("selftest.proxy_span") as s:
        s.set_attribute("openinference.span.kind", "CHAIN")
        s.set_attribute("openinference.project.name", "qmd")
    provider = trace.get_tracer_provider()
    print("provider:", type(provider).__name__)
    try:
        ok = provider.force_flush()
        print("force_flush:", ok)
    except Exception as e:
        print("flush err:", e)


@app.local_entrypoint()
def main():
    run_selftest.remote()
