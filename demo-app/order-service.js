'use strict';

// =============================================================================
// order-service — OTel Mastery Lab demo application
// Runtime: Node.js 20 (LTS), plain CommonJS — no transpilation required
// =============================================================================
// This service demonstrates:
//   - Auto-instrumentation via @opentelemetry/auto-instrumentations-node
//   - Manual span creation with custom attributes and span events
//   - Structured JSON logging with injected traceId / spanId
//   - Distributed tracing via downstream HTTP call to payment-service
//   - SIMULATE_ERRORS env var for incident-response exercises (Module 12)
// =============================================================================
// OTel SDK initialisation MUST happen before any other require() calls.
// The SDK is configured entirely via environment variables (set in docker-compose.yml):
//   OTEL_SERVICE_NAME=order-service
//   OTEL_EXPORTER_OTLP_ENDPOINT=http://otelcol-agent:4317
//   OTEL_EXPORTER_OTLP_PROTOCOL=grpc
//   OTEL_RESOURCE_ATTRIBUTES=deployment.environment=lab,service.version=1.0.0
// =============================================================================

const { NodeSDK } = require('@opentelemetry/sdk-node');
const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');
const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-grpc');
const { OTLPMetricExporter } = require('@opentelemetry/exporter-metrics-otlp-grpc');
const { PeriodicExportingMetricReader } = require('@opentelemetry/sdk-metrics');

// Initialise the SDK synchronously before loading Express or any other module.
// All configuration (endpoint, service name, resource attributes) comes from env vars.
const sdk = new NodeSDK({
  traceExporter: new OTLPTraceExporter(),
  metricReader: new PeriodicExportingMetricReader({
    exporter: new OTLPMetricExporter(),
    exportIntervalMillis: 10000,
  }),
  instrumentations: [
    getNodeAutoInstrumentations({
      // Disable noisy fs instrumentation; keep HTTP and Express.
      '@opentelemetry/instrumentation-fs': { enabled: false },
    }),
  ],
});

sdk.start();

// Graceful shutdown: flush all pending telemetry before the process exits.
process.on('SIGTERM', () => {
  sdk.shutdown()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
});

// =============================================================================
// Application code — loaded after SDK is running
// =============================================================================

const express = require('express');
const http = require('http');
const { v4: uuidv4 } = require('uuid');
const { trace, context, SpanStatusCode } = require('@opentelemetry/api');

const app = express();
app.use(express.json());

const PORT = parseInt(process.env.PORT || '8080', 10);
const PAYMENT_SERVICE_URL = process.env.PAYMENT_SERVICE_URL || 'http://payment-service:8081';
const SIMULATE_ERRORS = process.env.SIMULATE_ERRORS === 'true';
const LOG_LEVEL = (process.env.LOG_LEVEL || 'INFO').toUpperCase();

// =============================================================================
// Structured JSON logger
// Injects traceId and spanId from the active OTel context so that log records
// can be correlated with traces in New Relic.
// =============================================================================
const LEVELS = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };
const configuredLevel = LEVELS[LOG_LEVEL] ?? LEVELS.INFO;

function log(level, message, extra = {}) {
  if ((LEVELS[level] ?? 0) < configuredLevel) return;

  const activeSpan = trace.getActiveSpan();
  const spanContext = activeSpan ? activeSpan.spanContext() : null;

  const entry = {
    timestamp: new Date().toISOString(),
    level,
    service: 'order-service',
    message,
    traceId: spanContext ? spanContext.traceId : undefined,
    spanId: spanContext ? spanContext.spanId : undefined,
    ...extra,
  };

  // Remove undefined keys so the JSON output is clean.
  Object.keys(entry).forEach(k => entry[k] === undefined && delete entry[k]);

  process.stdout.write(JSON.stringify(entry) + '\n');
}

// =============================================================================
// Helper: call payment-service over plain HTTP
// Returns the parsed JSON response body on success, throws on error.
// =============================================================================
function callPaymentService(orderId, amount, currency) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ order_id: orderId, amount, currency });
    const url = new URL('/payments', PAYMENT_SERVICE_URL);

    const options = {
      hostname: url.hostname,
      port: url.port || 8081,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    };

    const req = http.request(options, (res) => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            resolve(JSON.parse(body));
          } catch {
            resolve({ raw: body });
          }
        } else {
          reject(new Error(`payment-service returned ${res.statusCode}: ${body}`));
        }
      });
    });

    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// =============================================================================
// POST /orders
// Creates a manual OTel span wrapping the full order processing flow.
// Custom attributes added to the span:
//   order.id        — UUID generated per request
//   order.item      — item name from request body
//   order.quantity  — quantity from request body
//   user.tier       — "standard" or "premium" from request body
//
// Note: the customer email is deliberately written to the structured logs (not
// to the span) so the Level 201 Module 7 challenge has a real PII field to redact
// at the Collector. It is never attached as a span attribute.
// =============================================================================
app.post('/orders', async (req, res) => {
  const tracer = trace.getTracer('order-service', '1.0.0');

  await tracer.startActiveSpan('process-order', async (span) => {
    try {
      const { item, quantity, user_tier: userTier = 'standard', user_email: userEmail } = req.body;

      // Input validation — returns 400 with a span error status.
      if (!item || quantity === undefined || quantity === null) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: 'Missing required fields: item, quantity' });
        span.setAttribute('error.type', 'validation_error');
        log('WARN', 'Order validation failed', { reason: 'missing fields', body: req.body });
        span.end();
        return res.status(400).json({ error: 'item and quantity are required' });
      }

      if (typeof quantity !== 'number' || quantity <= 0) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: 'quantity must be a positive number' });
        span.setAttribute('error.type', 'validation_error');
        span.setAttribute('order.quantity', quantity);
        log('WARN', 'Order validation failed', { reason: 'invalid quantity', quantity });
        span.end();
        return res.status(400).json({ error: 'quantity must be a positive number' });
      }

      // Simulate random errors (Module 12 incident-response exercise).
      if (SIMULATE_ERRORS && Math.random() < 0.10) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: 'Simulated internal error' });
        span.setAttribute('error.type', 'simulated_error');
        log('ERROR', 'Simulated error triggered', { item, quantity, userTier });
        span.end();
        return res.status(500).json({ error: 'Internal server error (simulated)' });
      }

      const orderId = uuidv4();
      const amount = parseFloat((quantity * (Math.random() * 90 + 10)).toFixed(2));
      const currency = 'USD';

      // Customer email is PII. It is intentionally carried into the logs only
      // (never the span) so Module 7 can demonstrate redacting it at the Collector.
      const customerEmail = userEmail || `customer+${orderId.slice(0, 8)}@example.com`;

      // Attach custom business attributes to the span.
      span.setAttributes({
        'order.id': orderId,
        'order.item': item,
        'order.quantity': quantity,
        'user.tier': userTier,
        'order.amount': amount,
        'order.currency': currency,
      });

      log('INFO', 'Processing order', { orderId, item, quantity, userTier, amount, 'user.email': customerEmail });

      // Call payment-service. Distributed tracing propagates automatically via
      // the auto-instrumentation HTTP instrumentation (W3C TraceContext headers).
      let paymentResult;
      try {
        paymentResult = await callPaymentService(orderId, amount, currency);
      } catch (paymentErr) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: paymentErr.message });
        span.setAttribute('error.type', 'payment_error');
        span.recordException(paymentErr);
        log('ERROR', 'Payment service call failed', { orderId, error: paymentErr.message });
        span.end();
        return res.status(502).json({ error: 'Payment processing failed' });
      }

      // Record a span event to mark order completion.
      span.addEvent('order.completed', {
        'order.id': orderId,
        'payment.id': paymentResult.payment_id || 'unknown',
        'order.amount': amount,
      });

      span.setStatus({ code: SpanStatusCode.OK });

      log('INFO', 'Order completed', {
        orderId,
        paymentId: paymentResult.payment_id,
        amount,
        userTier,
        'user.email': customerEmail,
      });

      span.end();
      return res.status(201).json({
        order_id: orderId,
        item,
        quantity,
        amount,
        currency,
        user_tier: userTier,
        payment: paymentResult,
        status: 'confirmed',
      });

    } catch (err) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
      span.recordException(err);
      log('ERROR', 'Unexpected error in POST /orders', { error: err.message, stack: err.stack });
      span.end();
      return res.status(500).json({ error: 'Internal server error' });
    }
  });
});

// =============================================================================
// GET /health
// Used by Docker Compose health check and load generator startup probe.
// =============================================================================
app.get('/health', (_req, res) => {
  res.status(200).json({ status: 'ok', service: 'order-service' });
});

// =============================================================================
// Start the server
// =============================================================================
app.listen(PORT, '0.0.0.0', () => {
  log('INFO', `order-service listening on port ${PORT}`, {
    port: PORT,
    simulateErrors: SIMULATE_ERRORS,
    logLevel: LOG_LEVEL,
    paymentServiceUrl: PAYMENT_SERVICE_URL,
  });
});
