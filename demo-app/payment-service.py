"""
payment-service — OTel Mastery Lab demo application
Runtime: Python 3.11, Flask

This service demonstrates:
  - Manual span creation with custom attributes and span events
  - Custom metrics: payment.processed (counter) and payment.amount (histogram)
  - Structured JSON logging with injected traceId / spanId
  - Simulated DB call latency (random sleep 10-50ms)
  - SIMULATE_SLOW env var for tail-sampling and latency exercises (M9, M12)

OTel configuration via environment variables (set in docker-compose.yml):
  OTEL_SERVICE_NAME=payment-service
  OTEL_EXPORTER_OTLP_ENDPOINT=http://otelcol-agent:4317
  OTEL_EXPORTER_OTLP_PROTOCOL=grpc
  OTEL_RESOURCE_ATTRIBUTES=deployment.environment=lab,service.version=1.0.0
"""

import json
import logging
import os
import random
import time
from datetime import datetime, timezone

from flask import Flask, request, jsonify

# OpenTelemetry imports
from opentelemetry import trace, metrics
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.sdk.metrics import MeterProvider
from opentelemetry.sdk.metrics.export import PeriodicExportingMetricReader
from opentelemetry.sdk.resources import Resource, SERVICE_NAME
from opentelemetry.exporter.otlp.proto.grpc.trace_exporter import OTLPSpanExporter
from opentelemetry.exporter.otlp.proto.grpc.metric_exporter import OTLPMetricExporter
from opentelemetry.instrumentation.flask import FlaskInstrumentor
from opentelemetry.instrumentation.requests import RequestsInstrumentor
from opentelemetry.trace import SpanStatusCode
from opentelemetry.trace.propagation.tracecontext import TraceContextTextMapPropagator

# =============================================================================
# OTel SDK Initialisation
# All configuration comes from environment variables. The Resource is built
# from OTEL_SERVICE_NAME and OTEL_RESOURCE_ATTRIBUTES automatically.
# =============================================================================

_resource = Resource.create({
    SERVICE_NAME: os.environ.get("OTEL_SERVICE_NAME", "payment-service"),
})

# Trace provider
_trace_exporter = OTLPSpanExporter()
_tracer_provider = TracerProvider(resource=_resource)
_tracer_provider.add_span_processor(BatchSpanProcessor(_trace_exporter))
trace.set_tracer_provider(_tracer_provider)

# Metric provider
_metric_exporter = OTLPMetricExporter()
_metric_reader = PeriodicExportingMetricReader(
    exporter=_metric_exporter,
    export_interval_millis=10_000,
)
_meter_provider = MeterProvider(resource=_resource, metric_readers=[_metric_reader])
metrics.set_meter_provider(_meter_provider)

# Auto-instrument Flask and requests (if used for outbound calls)
FlaskInstrumentor().instrument()
RequestsInstrumentor().instrument()

# Tracer and Meter handles used throughout this module
tracer = trace.get_tracer("payment-service", "1.0.0")
meter = metrics.get_meter("payment-service", "1.0.0")

# =============================================================================
# Custom Metrics
# payment.processed — counter incremented once per successful payment
# payment.amount    — histogram recording the payment amount per transaction
# =============================================================================
payment_processed_counter = meter.create_counter(
    name="payment.processed",
    description="Number of payments successfully processed",
    unit="1",
)

payment_amount_histogram = meter.create_histogram(
    name="payment.amount",
    description="Distribution of payment amounts in USD",
    unit="USD",
)

# =============================================================================
# Structured JSON Logger
# Injects traceId and spanId from the active OTel span so that log records
# can be correlated with traces in New Relic (Module 7).
# =============================================================================

LOG_LEVEL = os.environ.get("LOG_LEVEL", "INFO").upper()
LOG_LEVELS = {"DEBUG": 10, "INFO": 20, "WARN": 30, "ERROR": 40}
_configured_level = LOG_LEVELS.get(LOG_LEVEL, 20)

# Suppress default Flask / Werkzeug logging to avoid duplicate output.
logging.getLogger("werkzeug").setLevel(logging.ERROR)


def log(level: str, message: str, **extra):
    """Write a structured JSON log line to stdout."""
    if LOG_LEVELS.get(level.upper(), 20) < _configured_level:
        return

    current_span = trace.get_current_span()
    ctx = current_span.get_span_context() if current_span else None

    entry = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "level": level.upper(),
        "service": "payment-service",
        "message": message,
    }

    if ctx and ctx.is_valid:
        # Format traceId/spanId as hex strings matching the W3C TraceContext format.
        entry["traceId"] = format(ctx.trace_id, "032x")
        entry["spanId"] = format(ctx.span_id, "016x")

    entry.update(extra)
    print(json.dumps(entry), flush=True)


# =============================================================================
# Flask Application
# =============================================================================

app = Flask(__name__)

SIMULATE_SLOW = os.environ.get("SIMULATE_SLOW", "false").lower() == "true"
PORT = int(os.environ.get("PORT", "8081"))

# Simulated payment gateways (randomly selected per request to vary telemetry)
GATEWAYS = ["stripe-sim", "paypal-sim", "adyen-sim"]


def simulate_db_call():
    """Simulate a database write with realistic latency (10-50ms)."""
    time.sleep(random.uniform(0.010, 0.050))


# =============================================================================
# POST /payments
# Called by order-service with JSON body: {order_id, amount, currency}
# Creates a manual span, records custom metrics, simulates DB latency.
# =============================================================================

@app.route("/payments", methods=["POST"])
def process_payment():
    data = request.get_json(force=True, silent=True) or {}
    order_id = data.get("order_id", "unknown")
    amount = float(data.get("amount", 0.0))
    currency = data.get("currency", "USD")
    gateway = random.choice(GATEWAYS)

    with tracer.start_as_current_span("process-payment") as span:
        # Attach business attributes to the span.
        span.set_attributes({
            "payment.order_id": order_id,
            "payment.amount": amount,
            "payment.currency": currency,
            "payment.gateway": gateway,
        })

        log("INFO", "Processing payment", order_id=order_id, amount=amount, currency=currency, gateway=gateway)

        # Simulate slow processing (Module 9 tail-sampling / Module 12 latency exercises).
        if SIMULATE_SLOW:
            delay = random.uniform(0.200, 2.000)
            log("DEBUG", "Simulated slow processing", delay_ms=round(delay * 1000))
            time.sleep(delay)

        # Simulate a DB write.
        with tracer.start_as_current_span("db.write") as db_span:
            db_span.set_attributes({
                "db.system": "postgresql",
                "db.operation": "INSERT",
                "db.name": "payments",
            })
            simulate_db_call()

        payment_id = f"pay_{order_id[:8]}_{random.randint(1000, 9999)}"

        # Record a span event on payment completion.
        span.add_event("payment.authorized", {
            "payment.id": payment_id,
            "payment.gateway": gateway,
            "payment.amount": amount,
        })

        span.set_status(SpanStatusCode.OK)

        # Increment counter and record histogram value.
        # Attributes here become dimensions in New Relic metric facets.
        payment_processed_counter.add(1, {
            "payment.gateway": gateway,
            "payment.currency": currency,
        })
        payment_amount_histogram.record(amount, {
            "payment.gateway": gateway,
            "payment.currency": currency,
        })

        log("INFO", "Payment authorized", payment_id=payment_id, gateway=gateway, amount=amount)

        return jsonify({
            "payment_id": payment_id,
            "order_id": order_id,
            "amount": amount,
            "currency": currency,
            "gateway": gateway,
            "status": "authorized",
        }), 200


# =============================================================================
# GET /health
# Used by Docker Compose health check and order-service startup probe.
# =============================================================================

@app.route("/health", methods=["GET"])
def health():
    return jsonify({"status": "ok", "service": "payment-service"}), 200


# =============================================================================
# Entrypoint
# =============================================================================

if __name__ == "__main__":
    log("INFO", "payment-service starting", port=PORT, simulate_slow=SIMULATE_SLOW, log_level=LOG_LEVEL)
    # Use the built-in Flask dev server for the lab (single-threaded is fine).
    # For production use gunicorn or uvicorn.
    app.run(host="0.0.0.0", port=PORT, debug=False)
