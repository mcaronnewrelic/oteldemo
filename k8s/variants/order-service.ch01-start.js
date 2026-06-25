'use strict';

// =============================================================================
// order-service, CHALLENGE 01 STARTER (Level 201, Module 5)
// =============================================================================
// This is a deliberately regressed version of order-service.js for the
// "Deepen the instrumentation" challenge. Two things are wrong on purpose:
//
//   1. The POST /orders handler has NO manual span and sets NO custom business
//      attributes. Auto-instrumentation still produces one HTTP server span, so
//      the business logic (validation, pricing) is an invisible black box and
//      there are no order.* / user.tier attributes to query.
//        TODO: wrap the handler body in a manual `process-order` span and attach
//        order.id, order.item, order.quantity, order.amount, user.tier, etc.
//
//   2. The call to payment-service is made inside a DETACHED root context, so
//      the outbound request starts a brand-new trace and the distributed trace
//      fragments (order-service and payment-service show as two traces).
//        FIX: remove the `context.with(ROOT_CONTEXT, ...)` wrapper so the active
//        context propagates to payment-service.
//
// The solved reference is the canonical demo-app/order-service.js.
// =============================================================================

const { NodeSDK } = require('@opentelemetry/sdk-node');
const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');
const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-grpc');
const { OTLPMetricExporter } = require('@opentelemetry/exporter-metrics-otlp-grpc');
const { PeriodicExportingMetricReader } = require('@opentelemetry/sdk-metrics');

const sdk = new NodeSDK({
  traceExporter: new OTLPTraceExporter(),
  metricReader: new PeriodicExportingMetricReader({
    exporter: new OTLPMetricExporter(),
    exportIntervalMillis: 10000,
  }),
  instrumentations: [
    getNodeAutoInstrumentations({
      '@opentelemetry/instrumentation-fs': { enabled: false },
    }),
  ],
});

sdk.start();

process.on('SIGTERM', () => {
  sdk.shutdown().then(() => process.exit(0)).catch(() => process.exit(1));
});

const express = require('express');
const http = require('http');
const { v4: uuidv4 } = require('uuid');
// ROOT_CONTEXT is imported here only to support the deliberate propagation bug.
const { trace, context, ROOT_CONTEXT, SpanStatusCode } = require('@opentelemetry/api');

const app = express();
app.use(express.json());

const PORT = parseInt(process.env.PORT || '8080', 10);
const PAYMENT_SERVICE_URL = process.env.PAYMENT_SERVICE_URL || 'http://payment-service:8081';
const SIMULATE_ERRORS = process.env.SIMULATE_ERRORS === 'true';
const LOG_LEVEL = (process.env.LOG_LEVEL || 'INFO').toUpperCase();

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
  Object.keys(entry).forEach(k => entry[k] === undefined && delete entry[k]);
  process.stdout.write(JSON.stringify(entry) + '\n');
}

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
          try { resolve(JSON.parse(body)); } catch { resolve({ raw: body }); }
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
// POST /orders, STARTER: no manual span, no custom attributes, broken propagation
// =============================================================================
app.post('/orders', async (req, res) => {
  try {
    const { item, quantity, user_tier: userTier = 'standard', user_email: userEmail } = req.body;

    if (!item || quantity === undefined || quantity === null) {
      log('WARN', 'Order validation failed', { reason: 'missing fields', body: req.body });
      return res.status(400).json({ error: 'item and quantity are required' });
    }
    if (typeof quantity !== 'number' || quantity <= 0) {
      log('WARN', 'Order validation failed', { reason: 'invalid quantity', quantity });
      return res.status(400).json({ error: 'quantity must be a positive number' });
    }
    if (SIMULATE_ERRORS && Math.random() < 0.10) {
      log('ERROR', 'Simulated error triggered', { item, quantity, userTier });
      return res.status(500).json({ error: 'Internal server error (simulated)' });
    }

    const orderId = uuidv4();
    const amount = parseFloat((quantity * (Math.random() * 90 + 10)).toFixed(2));
    const currency = 'USD';
    const customerEmail = userEmail || `customer+${orderId.slice(0, 8)}@example.com`;

    log('INFO', 'Processing order', { orderId, item, quantity, userTier, amount, 'user.email': customerEmail });

    // BUG: the payment call runs in a detached root context, fragmenting the trace.
    // FIX: call payment-service directly so the active context propagates:
    //   paymentResult = await callPaymentService(orderId, amount, currency);
    let paymentResult;
    try {
      paymentResult = await context.with(ROOT_CONTEXT, () => callPaymentService(orderId, amount, currency));
    } catch (paymentErr) {
      log('ERROR', 'Payment service call failed', { orderId, error: paymentErr.message });
      return res.status(502).json({ error: 'Payment processing failed' });
    }

    log('INFO', 'Order completed', { orderId, paymentId: paymentResult.payment_id, amount, userTier, 'user.email': customerEmail });

    return res.status(201).json({
      order_id: orderId, item, quantity, amount, currency,
      user_tier: userTier, payment: paymentResult, status: 'confirmed',
    });
  } catch (err) {
    log('ERROR', 'Unexpected error in POST /orders', { error: err.message, stack: err.stack });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/health', (_req, res) => {
  res.status(200).json({ status: 'ok', service: 'order-service' });
});

app.listen(PORT, '0.0.0.0', () => {
  log('INFO', `order-service listening on port ${PORT}`, {
    port: PORT, simulateErrors: SIMULATE_ERRORS, logLevel: LOG_LEVEL, paymentServiceUrl: PAYMENT_SERVICE_URL,
  });
});
