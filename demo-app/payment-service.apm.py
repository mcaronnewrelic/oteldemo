"""
payment-service.apm.py — APM-agent variant for the OTel 301 migration lab.

This is the SAME payment-service as payment-service.py, but instrumented by the
New Relic Python APM agent INSTEAD of OpenTelemetry. There is no OTel SDK here:
no TracerProvider, no OTLP exporter, no manual spans. The service is launched
under the agent with:

    newrelic-admin run-program python /app/src/payment-service.apm.py

(with NEW_RELIC_LICENSE_KEY and NEW_RELIC_APP_NAME set). The agent auto-
instruments Flask and the outbound `requests` calls and reports to New Relic APM.

It exposes the identical /payments and /health endpoints and the identical
response shape, so order-service calls succeed exactly as before. The point of
the 301 migration challenge is that, in this state, payment-service emits NO
OpenTelemetry spans, so the order to payment distributed trace is NOT complete
in OTel. Migrating the service back to OTel (payment-service.py) reconnects it.
"""

import json
import logging
import os
import random
import time
from datetime import datetime, timezone

from flask import Flask, jsonify, request

# =============================================================================
# Structured JSON Logger
# No OTel here, so no traceId/spanId injection. The New Relic APM agent adds its
# own linking metadata when configured. This keeps log output shape consistent.
# =============================================================================

LOG_LEVEL = os.environ.get("LOG_LEVEL", "INFO").upper()
LOG_LEVELS = {"DEBUG": 10, "INFO": 20, "WARN": 30, "ERROR": 40}
_configured_level = LOG_LEVELS.get(LOG_LEVEL, 20)

logging.getLogger("werkzeug").setLevel(logging.ERROR)


def log(level: str, message: str, **extra):
    """Write a structured JSON log line to stdout."""
    if LOG_LEVELS.get(level.upper(), 20) < _configured_level:
        return
    entry = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "level": level.upper(),
        "service": "payment-service",
        "message": message,
        "instrumentation": "newrelic-apm-agent",
    }
    entry.update(extra)
    print(json.dumps(entry), flush=True)


# =============================================================================
# Flask Application (instrumented by the New Relic APM agent, not OTel)
# =============================================================================

app = Flask(__name__)

SIMULATE_SLOW = os.environ.get("SIMULATE_SLOW", "false").lower() == "true"
PORT = int(os.environ.get("PORT", "8081"))

GATEWAYS = ["stripe-sim", "paypal-sim", "adyen-sim"]


def simulate_db_call():
    """Simulate a database write with realistic latency (10-50ms)."""
    time.sleep(random.uniform(0.010, 0.050))


@app.route("/payments", methods=["POST"])
def process_payment():
    data = request.get_json(force=True, silent=True) or {}
    order_id = data.get("order_id", "unknown")
    amount = float(data.get("amount", 0.0))
    currency = data.get("currency", "USD")
    gateway = random.choice(GATEWAYS)

    log("INFO", "Processing payment", order_id=order_id, amount=amount, currency=currency, gateway=gateway)

    if SIMULATE_SLOW:
        delay = random.uniform(0.200, 2.000)
        log("DEBUG", "Simulated slow processing", delay_ms=round(delay * 1000))
        time.sleep(delay)

    # Simulate a DB write (the APM agent records this as part of the transaction).
    simulate_db_call()

    payment_id = f"pay_{order_id[:8]}_{random.randint(1000, 9999)}"
    log("INFO", "Payment authorized", payment_id=payment_id, gateway=gateway, amount=amount)

    return jsonify({
        "payment_id": payment_id,
        "order_id": order_id,
        "amount": amount,
        "currency": currency,
        "gateway": gateway,
        "status": "authorized",
    }), 200


@app.route("/health", methods=["GET"])
def health():
    return jsonify({"status": "ok", "service": "payment-service"}), 200


if __name__ == "__main__":
    log("INFO", "payment-service starting (New Relic APM agent mode)", port=PORT, simulate_slow=SIMULATE_SLOW, log_level=LOG_LEVEL)
    app.run(host="0.0.0.0", port=PORT, debug=False)
