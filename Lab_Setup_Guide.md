# OpenTelemetry Mastery Course — Lab Environment Setup Guide

**Version:** 2.0  
**Course:** OTel Mastery for New Relic Customer Advocates (L101 / L201 / L301)  
**Audience:** Instructors and students  

---

## Table of Contents

1. [Prerequisites](#1-prerequisites)
2. [Quick Start (5 minutes)](#2-quick-start-5-minutes)
3. [Lab Architecture](#3-lab-architecture)
4. [Environment Variables](#4-environment-variables)
5. [Module-by-Module Lab Mapping](#5-module-by-module-lab-mapping)
6. [Generating Test Scenarios](#6-generating-test-scenarios)
7. [NRQL Quick Verification Queries](#7-nrql-quick-verification-queries)
8. [Broken Config Scenarios (Module 12)](#8-broken-config-scenarios-module-12)
9. [K8s Lab Setup (Module 9 — Optional)](#9-k8s-lab-setup-module-9--optional)
10. [Troubleshooting the Lab](#10-troubleshooting-the-lab)

---

## 1. Prerequisites

All lab exercises from Module 3 onward require the following environment. Verify each item before the first lab session.

### Required

| Requirement | Minimum Version | Verification Command |
|---|---|---|
| Docker Desktop | 4.x (Mac/Windows) or Docker Engine 24.x (Linux) | `docker version` |
| Docker Compose | v2 (included with Docker Desktop 4.x) | `docker compose version` |
| New Relic account | Any paid or trial account | Log in at one.newrelic.com |
| New Relic License Key | Ingest-type key | Account Settings → API Keys |
| Git | 2.x+ | `git --version` |
| curl | Any recent version | `curl --version` |

> **Important — Docker Compose v2:** The lab uses `docker compose` (with a space, not a hyphen). If you have the legacy `docker-compose` (v1) plugin installed, see [Section 10](#10-troubleshooting-the-lab) for the workaround.

### System Resources

| Resource | Minimum | Recommended |
|---|---|---|
| RAM | 8 GB (4 GB assigned to Docker) | 16 GB |
| CPU | 4 cores | 8 cores |
| Disk | 10 GB free | 20 GB free |

To check Docker Desktop memory allocation: Docker Desktop → Settings → Resources → Memory. Set to at least 4096 MB.

### Optional (Module 9+ Kubernetes exercises)

- **kubectl** 1.28+: `kubectl version --client`
- **kind** 0.22+ or **minikube** 1.32+: `kind version` or `minikube version`
- These are only required for the optional K8s track in Module 9. All other modules run on Docker Compose.

### New Relic License Key

1. Log in to [one.newrelic.com](https://one.newrelic.com)
2. Click your account name (top right) → **API Keys**
3. Find or create a key of type **INGEST - LICENSE**
4. Copy the full key — it starts with the first characters of your account ID

For EU accounts, note your OTLP endpoint is `https://otlp.eu01.nr-data.net` (see Section 4).

---

## 2. Quick Start (5 minutes)

### Step 1 — Get the lab files

If you received the lab as a zip archive, unzip it and `cd` into the `LabGuide` directory:

```bash
cd /path/to/LabGuide
```

If you are cloning from a Git repository:

```bash
git clone <repo-url> otel-lab
cd otel-lab/LabGuide
```

### Step 2 — Configure environment variables

```bash
cp .env.example .env
```

Open `.env` in any text editor and set the two required values:

```
NR_LICENSE_KEY=<your_40_character_license_key>
NR_OTLP_ENDPOINT=https://otlp.nr-data.net
```

For EU accounts, use `https://otlp.eu01.nr-data.net` instead.

All other variables have working defaults — leave them as-is for your first run.

### Step 3 — Start the lab stack

```bash
docker compose up -d
```

Docker will pull the required images on first run (approximately 1–2 GB). Subsequent starts are instant. Expected output:

```
[+] Running 4/4
 ✔ Container otelcol-agent      Started
 ✔ Container order-service      Started
 ✔ Container payment-service    Started
 ✔ Container load-generator     Started
```

> The `otelcol-gateway` container is **not** started by a plain `docker compose up` — it is gated behind a Compose profile and only used in the Module 9 two-tier exercise. Start it with `docker compose --profile gateway up -d`.

### Step 4 — Verify the lab is running

**Local health check (should respond immediately):**

```bash
curl http://localhost:8080/health
# Expected: {"status":"ok","service":"order-service"}

curl http://localhost:8081/health
# Expected: {"status":"ok","service":"payment-service"}
```

**Collector self-metrics (should respond within 10 seconds):**

```bash
curl http://localhost:8888/metrics | grep otelcol_exporter_sent
```

**New Relic data (allow 60–90 seconds after first start):**

Log in to [one.newrelic.com](https://one.newrelic.com), open the Query Builder, and run:

```sql
SELECT uniques(service.name) FROM Span SINCE 5 minutes ago
```

You should see `order-service` and `payment-service` in the results.

### Stopping the lab

```bash
docker compose down
```

To also remove volumes (resets all state):

```bash
docker compose down -v
```

---

## 3. Lab Architecture

### Services Overview

A plain `docker compose up` runs four containers. A fifth, `otelcol-gateway`, is gated behind the `gateway` Compose profile and only started for the Module 9 two-tier exercise. All services communicate on an internal Docker network (`otel-lab`).

| Container | Image | Port(s) | Role |
|---|---|---|---|
| `order-service` | node:20-alpine (custom) | 8080 | Demo application — receives orders |
| `payment-service` | python:3.11-slim (custom) | 8081 | Demo application — processes payments |
| `load-generator` | curlimages/curl:latest | — | Sends continuous HTTP traffic |
| `otelcol-agent` | otel/opentelemetry-collector-contrib:0.100.0 | 4317, 4318, 8888 | OTLP receiver + NR exporter |
| `otelcol-gateway` (profile: `gateway`) | otel/opentelemetry-collector-contrib:0.100.0 | 4320 | Two-tier gateway (Module 9). Not started by default — run `docker compose --profile gateway up -d`. |

### Service Descriptions

**order-service (Node.js/Express, port 8080)**

- Receives `POST /orders` with JSON body `{item, quantity, user_tier}`
- Creates a manual OpenTelemetry span for each order with custom attributes: `order.id`, `order.item`, `order.quantity`, `user.tier`
- Calls `payment-service` via HTTP to process payment (demonstrates distributed tracing)
- Records a span event on order completion
- Writes structured JSON logs to stdout **and** emits them as OTLP log records (correlated to the active span, so New Relic links each log to its trace)
- Respects `SIMULATE_ERRORS` env var: when `true`, 10% of requests return HTTP 500
- Exports traces, metrics, and logs to `otelcol-agent` via OTLP/gRPC on port 4317

**payment-service (Python/Flask, port 8081)**

- Receives `POST /payments` from order-service (internal only)
- Creates a manual span with attributes: `payment.amount`, `payment.currency`, `payment.gateway`
- Records custom metrics: `payment.processed` (counter) and `payment.amount` (histogram)
- Simulates a DB call (random sleep 10–50ms)
- Respects `SIMULATE_SLOW` env var: when `true`, adds 200–2000ms random latency
- Writes structured JSON logs to stdout **and** emits them as OTLP log records with trace context
- Exports traces, metrics, and logs to `otelcol-agent` via OTLP/gRPC

**load-generator**

- Runs a shell loop that POSTs orders to `order-service` at `LOAD_RATE` requests per second (default: 10 rps)
- Randomizes `user_tier` between `standard` and `premium` to generate varied telemetry
- Runs indefinitely in the background; stop with `docker compose stop load-generator`

**otelcol-agent**

- Receives OTLP traces, metrics, and logs from both application services
- Applies processors: `memory_limiter` (first), `batch`, `resource` (adds `deployment.environment=lab`); the logs pipeline also runs `transform/redact-pii`, which strips the customer email before export (Module 7)
- Exports all signals to New Relic via OTLP/HTTP with gzip compression
- Exposes self-metrics at `http://localhost:8888/metrics` (Prometheus format)
- Health check endpoint: `http://localhost:13133`. (The container has **no** Docker `healthcheck` — the collector-contrib image is distroless, so an exec-based probe can't run; liveness is checked via this endpoint.)

**otelcol-gateway (Module 9 exercise — profile: `gateway`)**

- Second-tier Collector used in Module 9 two-tier architecture exercises
- Receives OTLP from `otelcol-agent` on port 4320
- Applies tail-based sampling before forwarding to New Relic
- **Not started by default.** It is gated behind the `gateway` Compose profile; start it with `docker compose --profile gateway up -d`, then point `otelcol-agent` at `http://otelcol-gateway:4320`.

### Architecture Diagram

```
                         ┌─────────────────────────────────────────┐
                         │           Docker Network: otel-lab       │
                         │                                          │
  ┌──────────────┐       │  ┌─────────────┐   HTTP   ┌───────────┐ │
  │              │  POST │  │             │─────────▶│           │ │
  │  Student /   │──────▶│  │order-service│          │  payment  │ │
  │  curl cmds   │       │  │  :8080      │          │  service  │ │
  └──────────────┘       │  │  (Node.js)  │          │  :8081    │ │
                         │  └──────┬──────┘          │  (Python) │ │
  ┌──────────────┐       │         │ OTLP/gRPC        └─────┬─────┘ │
  │              │       │         │ :4317                  │ OTLP  │
  │    load-     │──────▶│         │                        │/gRPC  │
  │  generator   │       │         ▼                        ▼       │
  └──────────────┘       │  ┌──────────────────────────────────┐   │
                         │  │         otelcol-agent            │   │
                         │  │   recv:4317/4318  self:8888       │   │
                         │  │  [memory_limiter→batch→resource] │   │
                         │  └────────────┬─────────────────────┘   │
                         │               │                          │
                         │   (L301 only) │ OTLP/gRPC :4320          │
                         │               ▼                          │
                         │  ┌──────────────────────────────────┐   │
                         │  │        otelcol-gateway           │   │
                         │  │  [memory_limiter→tail_sampling   │   │
                         │  │   →resource→batch]               │   │
                         │  └────────────┬─────────────────────┘   │
                         │               │                          │
                         └───────────────┼──────────────────────────┘
                                         │ OTLP/HTTP (gzip)
                                         │ api-key: NR_LICENSE_KEY
                                         ▼
                               ┌──────────────────┐
                               │   New Relic       │
                               │  otlp.nr-data.net │
                               │  (US or EU)       │
                               └──────────────────┘
```

---

## 4. Environment Variables

All variables are set in `.env`. The lab reads them at `docker compose up` time.

| Variable | Required | Default | Description |
|---|---|---|---|
| `NR_LICENSE_KEY` | Yes | — | New Relic ingest license key. Must be an INGEST-LICENSE type key from your account's API Keys page. |
| `NR_OTLP_ENDPOINT` | Yes | `https://otlp.nr-data.net` | OTLP HTTP endpoint for New Relic. US accounts use the default. EU accounts use `https://otlp.eu01.nr-data.net`. Do not add a port number — the endpoint uses HTTPS/443. |
| `LOAD_RATE` | No | `10` | Requests per second the load-generator sends to order-service. Reduce to `2` or `3` on lower-spec machines. Increase to `50` to stress-test cardinality (Module 11). |
| `LOG_LEVEL` | No | `INFO` | Application log verbosity for both order-service and payment-service. Valid values: `DEBUG`, `INFO`, `WARN`, `ERROR`. Use `DEBUG` when troubleshooting missing trace context in logs. |
| `SIMULATE_ERRORS` | No | `false` | When `true`, order-service randomly returns HTTP 500 on approximately 10% of order requests. Used in Module 12 incident response exercises. |
| `SIMULATE_SLOW` | No | `false` | When `true`, payment-service adds a random delay of 200–2000ms to each payment. Used in Module 9 tail sampling and Module 12 latency exercises. |
| `COLLECTOR_CONFIG` | No | `collector-agent.yaml` | Filename (relative to `configs/`) of the Collector config to mount into `otelcol-agent`. Change this to swap configs without modifying `docker-compose.yml`. |

### Switching Collector Configs at Runtime

To change the active Collector config without restarting the entire stack:

```bash
# Switch to the gateway config (Module 9)
COLLECTOR_CONFIG=collector-gateway.yaml docker compose up -d otelcol-agent

# Switch to a broken config (Module 12)
COLLECTOR_CONFIG=collector-broken-1.yaml docker compose up -d otelcol-agent

# Return to the standard config
COLLECTOR_CONFIG=collector-agent.yaml docker compose up -d otelcol-agent
```

---

## 5. Module-by-Module Lab Mapping

| Module | Level | Services Used | Config File | Notes |
|---|---|---|---|---|
| M1 — What is OTel? | L101 | None (conceptual) | — | No live lab. Lecture + slides only. |
| M2 — OTel Signals | L101 | None (conceptual) | — | No live lab. Diagrams and whiteboard exercises. |
| M3 — NRDOT Install | L101 | order-service + otelcol-agent | `collector-agent.yaml` | Students install NRDOT, verify data flows from order-service to NR. |
| M4 — NRQL Basics | L101 | order-service + payment-service + otelcol-agent | `collector-agent.yaml` | Full stack running; students write NRQL against live data. |
| M5 — Manual Instrumentation | L201 | order-service (modified) | `collector-agent.yaml` | Students modify `order-service.js` to add custom spans and attributes. |
| M6 — Collector Pipelines | L201 | Both services + otelcol-agent | `collector-agent-exercise.yaml` | Starter skeleton with `TODO` markers; students build up the pipelines from it. |
| M7 — Logs | L201 | Both services + otelcol-agent | `collector-agent.yaml` | Logs already flow: the apps emit OTLP logs correlated to spans, and the default config redacts the PII email. Students validate log-to-trace correlation and PII redaction. |
| M8 — Health & Cost | L201 | Full stack + self-monitoring | `collector-selfmon.yaml` | Collector self-metrics dashboard; cost estimation with NRQL. |
| M9 — Advanced Collector | L301 | Full stack + otelcol-gateway | `collector-gateway.yaml` | Two-tier architecture; tail sampling policies. Start the gateway with `docker compose --profile gateway up -d`. K8s optional. |
| M10 — Migration | L301 | order-service (APM → OTel) | — | Students swap a New Relic APM agent for OTel SDK instrumentation. |
| M11 — Cardinality | L301 | Full stack | `collector-cardinality.yaml` | Cardinality audit; transform processor to drop high-cardinality attributes. |
| M12 — Incident Response | L301 | Full stack (broken configs) | `collector-broken-*.yaml` | Troubleshooting exercises; students diagnose and fix three broken configs. |

### Starting the Stack for Each Module

**L101 (M3–M4):** Standard start:
```bash
docker compose up -d
```

**L201 (M5–M8):** Enable error and slow simulation for richer data:
```bash
SIMULATE_ERRORS=true SIMULATE_SLOW=true docker compose up -d
```

**L301 (M9, M11–M12):** Full stack including the two-tier gateway (add `--profile gateway`):
```bash
SIMULATE_ERRORS=true SIMULATE_SLOW=true docker compose --profile gateway up -d
```
(M11 and M12 don't need the gateway; only M9 does. Omit `--profile gateway` if you're not running the two-tier exercise.)

**M12 only (broken configs):** See Section 8.

---

## 6. Generating Test Scenarios

Use these `curl` commands to trigger specific behaviors and generate targeted telemetry. Run them from any terminal on the host machine while the stack is running.

### Standard Orders

```bash
# Normal order — standard tier
curl -X POST http://localhost:8080/orders \
  -H "Content-Type: application/json" \
  -d '{"item": "widget", "quantity": 3, "user_tier": "standard"}'

# Normal order — premium tier (triggers user.tier=premium span attribute)
curl -X POST http://localhost:8080/orders \
  -H "Content-Type: application/json" \
  -d '{"item": "gadget", "quantity": 10, "user_tier": "premium"}'

# Large order — useful for histogram distribution in Module 11
curl -X POST http://localhost:8080/orders \
  -H "Content-Type: application/json" \
  -d '{"item": "enterprise-package", "quantity": 500, "user_tier": "premium"}'
```

### Error Scenarios

```bash
# Trigger a validation error (quantity=0 is invalid)
curl -X POST http://localhost:8080/orders \
  -H "Content-Type: application/json" \
  -d '{"item": "widget", "quantity": 0}'

# Missing required field — triggers 400
curl -X POST http://localhost:8080/orders \
  -H "Content-Type: application/json" \
  -d '{"item": "widget"}'

# Enable random 500 errors without restarting the stack
# (requires setting SIMULATE_ERRORS=true in .env first, then restart order-service)
docker compose restart order-service
```

### Health and Observability Checks

```bash
# Service health endpoints
curl http://localhost:8080/health
curl http://localhost:8081/health

# Collector health check
curl http://localhost:13133

# Collector self-metrics (Prometheus format) — filter for exporter metrics
curl -s http://localhost:8888/metrics | grep otelcol_exporter

# Count of spans exported successfully
curl -s http://localhost:8888/metrics | grep otelcol_exporter_sent_spans

# Check for export failures (should be 0)
curl -s http://localhost:8888/metrics | grep otelcol_exporter_send_failed
```

### Load Generator Control

```bash
# Stop the load generator (manual curl commands only)
docker compose stop load-generator

# Restart with a higher rate
LOAD_RATE=50 docker compose up -d load-generator

# Restart with a lower rate
LOAD_RATE=2 docker compose up -d load-generator
```

### Collector Log Inspection

```bash
# Watch Collector logs in real time
docker logs -f otelcol-agent

# Watch gateway logs
docker logs -f otelcol-gateway

# Filter for errors only
docker logs otelcol-agent 2>&1 | grep -i error

# Filter for export activity
docker logs otelcol-agent 2>&1 | grep -i "export"
```

---

## 7. NRQL Quick Verification Queries

After `docker compose up`, allow 60–90 seconds for telemetry to reach New Relic. Run these queries in the [NR Query Builder](https://one.newrelic.com/data-exploration) to confirm all signals are flowing.

### Signal Verification

```sql
-- Are both services visible as span sources?
SELECT uniques(service.name) FROM Span SINCE 5 minutes ago

-- Are traces flowing? (Should show increasing counts)
SELECT count(*) FROM Span
FACET service.name
TIMESERIES 1 minute
SINCE 10 minutes ago

-- Are metrics flowing?
SELECT count(*) FROM Metric
WHERE instrumentation.provider = 'opentelemetry'
FACET metricName
SINCE 5 minutes ago
LIMIT 10

-- Are logs flowing?
SELECT count(*) FROM Log
FACET service.name
SINCE 5 minutes ago

-- Were service entities created?
SELECT uniques(entity.name) FROM Span
WHERE entity.type = 'SERVICE'
SINCE 5 minutes ago
```

### Custom Attribute Verification (Module 5)

```sql
-- Confirm custom span attributes from order-service
SELECT order.item, order.quantity, user.tier, order.id
FROM Span
WHERE service.name = 'order-service'
SINCE 10 minutes ago
LIMIT 20

-- Confirm payment-service custom attributes
SELECT payment.amount, payment.currency, payment.gateway
FROM Span
WHERE service.name = 'payment-service'
SINCE 10 minutes ago
LIMIT 20
```

### Metric Verification (payment-service custom metrics)

```sql
-- Payment counter
SELECT sum(payment.processed) FROM Metric
FACET payment.gateway
TIMESERIES 1 minute
SINCE 10 minutes ago

-- Payment amount histogram (p95 latency pattern)
SELECT histogram(payment.amount, 10, 20) FROM Metric
SINCE 10 minutes ago
```

### Log-Trace Correlation (Module 7)

> Logs arrive as OTLP log records, so New Relic stores the trace linkage in the standard
> `trace.id` / `span.id` attributes (dotted) — not `traceId` / `spanId`. Use those below.

```sql
-- Logs with trace context (each row links to its trace in the UI)
SELECT message, trace.id, span.id, service.name
FROM Log
WHERE trace.id IS NOT NULL
SINCE 5 minutes ago
LIMIT 20

-- Logs without trace context (should be ~0 for the demo services)
SELECT count(*) FROM Log
WHERE trace.id IS NULL AND service.name IN ('order-service', 'payment-service')
SINCE 5 minutes ago

-- PII redaction check (Module 7): the customer email must NOT appear — it is
-- redacted at the Collector. This should return 0.
SELECT count(*) FROM Log
WHERE message LIKE '%@example.com%' OR user.email IS NOT NULL
SINCE 5 minutes ago
```

### Collector Self-Metrics (Module 8)

```sql
-- Collector export success rate
SELECT average(otelcol_exporter_sent_spans)
FROM Metric
WHERE job = 'otelcol-self'
TIMESERIES 1 minute
SINCE 30 minutes ago

-- Memory usage
SELECT average(otelcol_process_memory_rss)
FROM Metric
WHERE job = 'otelcol-self'
TIMESERIES 1 minute
SINCE 30 minutes ago
```

### Error Rate Verification (SIMULATE_ERRORS=true)

```sql
-- HTTP error rate by service
SELECT percentage(count(*), WHERE http.status_code >= 500) AS 'Error Rate'
FROM Span
FACET service.name
TIMESERIES 1 minute
SINCE 15 minutes ago

-- Slow spans (SIMULATE_SLOW=true — should show p95 > 500ms)
SELECT percentile(duration.ms, 50, 95, 99)
FROM Span
WHERE service.name = 'payment-service'
TIMESERIES 1 minute
SINCE 15 minutes ago
```

---

## 8. Broken Config Scenarios (Module 12)

Module 12 uses three intentionally broken Collector configs as troubleshooting exercises. Students diagnose each issue using Collector logs, self-metrics, and NRQL.

### Overview

| File | Exercise | Bug | Symptom |
|---|---|---|---|
| `collector-broken-1.yaml` | 2A | `memory_limiter` placed after `batch` (wrong processor order) | Memory spikes; potential OOM; batch fills before limiter can act |
| `collector-broken-2.yaml` | 2B | `api-key: INVALID_KEY_REPLACE_ME` in exporter headers | 403 errors in Collector logs; no data in New Relic |
| `collector-broken-3.yaml` | 2C | `num_traces: 50` in tail sampling (too low for 10 rps load) | Traces dropped; only a fraction appear in New Relic |

### Switching to a Broken Config

```bash
# Exercise 2A — processor ordering
COLLECTOR_CONFIG=collector-broken-1.yaml docker compose up -d otelcol-agent

# Exercise 2B — bad API key
COLLECTOR_CONFIG=collector-broken-2.yaml docker compose up -d otelcol-agent

# Exercise 2C — tail sampling too low
COLLECTOR_CONFIG=collector-broken-3.yaml docker compose up -d otelcol-agent

# Return to working config after each exercise
COLLECTOR_CONFIG=collector-agent.yaml docker compose up -d otelcol-agent
```

### Diagnostic Commands for Students

```bash
# Watch for errors in real time
docker logs -f otelcol-agent

# Check export failure count (Exercise 2B will show non-zero)
curl -s http://localhost:8888/metrics | grep otelcol_exporter_send_failed

# Check memory usage (Exercise 2A — watch for growth)
curl -s http://localhost:8888/metrics | grep otelcol_process_memory_rss

# Check tail sampler decision count (Exercise 2C)
curl -s http://localhost:8888/metrics | grep otelcol_processor_tail_sampling
```

### Exercise 2A — Processor Ordering (collector-broken-1.yaml)

**Bug:** The `memory_limiter` processor is placed after `batch` in all three pipelines.  
**Why it matters:** `memory_limiter` must be first. If placed after `batch`, the batch processor fills memory buffers before the limiter can shed load, defeating its purpose and risking OOM crashes under load spikes.  
**Fix:** Move `memory_limiter` to be the first processor in every pipeline.

### Exercise 2B — Authentication Failure (collector-broken-2.yaml)

**Bug:** The `api-key` header in the `otlphttp/newrelic` exporter is set to a placeholder value.  
**Symptom:** Collector logs show repeated `HTTP 403` or `HTTP 401` responses from `otlp.nr-data.net`. No data appears in New Relic despite the Collector running cleanly.  
**Fix:** Replace `INVALID_KEY_REPLACE_ME` with `${env:NR_LICENSE_KEY}`.

### Exercise 2C — Tail Sampling Undersized (collector-broken-3.yaml)

**Bug:** `num_traces: 50` in the tail sampling processor. At 10 rps with traces that span multiple services, the buffer fills within seconds and the sampler drops traces before evaluating policies.  
**Symptom:** Intermittent traces in New Relic; `otelcol_processor_tail_sampling_sampling_decision_timer_firing_time` metric shows very frequent timer fires; dropped trace count climbs.  
**Fix:** Increase `num_traces` to at least `5000` (500× the default rps × expected trace duration in seconds).

---

## 9. K8s Lab Setup (Module 9 — Optional)

This section covers the optional Kubernetes track for Module 9. It is not required for any other module.

### Prerequisites

- `kubectl` 1.28+ installed and on your `$PATH`
- `kind` 0.22+ or `minikube` 1.32+
- At least 6 GB RAM available for the cluster

### Create a Local Cluster with kind

```bash
# Create the cluster
kind create cluster --name otel-lab --config k8s/kind-config.yaml

# Verify it is running
kubectl cluster-info --context kind-otel-lab

# Set context
kubectl config use-context kind-otel-lab
```

### Deploy the Lab Stack to Kubernetes

```bash
# Create the namespace
kubectl create namespace otel-lab

# Create the NR license key secret
kubectl create secret generic newrelic-license \
  --from-literal=license-key="${NR_LICENSE_KEY}" \
  -n otel-lab

# Apply all manifests
kubectl apply -f k8s/ -n otel-lab

# Verify pods are running
kubectl get pods -n otel-lab
```

### Access Services from the Host

```bash
# Port-forward the Collector agent (so app services can reach it during exercises)
kubectl port-forward svc/otelcol-agent 4317:4317 -n otel-lab &

# Port-forward order-service for manual curl commands
kubectl port-forward svc/order-service 8080:8080 -n otel-lab &

# Port-forward Collector self-metrics
kubectl port-forward svc/otelcol-agent 8888:8888 -n otel-lab &
```

### Module 9 K8s Exercises

The Module 9 exercise YAML files in `k8s/` cover:

- **DaemonSet deployment** of the OTel Collector agent (one pod per node)
- **StatefulSet deployment** of the OTel Collector gateway with persistent queue
- **ConfigMap-based** Collector configuration (edit and `kubectl apply` to reload)
- **Namespace-scoped RBAC** for the Collector service account

Refer to the Module 9 exercise guide for step-by-step instructions on modifying the manifests.

### Clean Up

```bash
# Remove the cluster entirely
kind delete cluster --name otel-lab
```

---

## 10. Troubleshooting the Lab

### Port Already in Use

If `docker compose up` fails with `address already in use`, one of the required ports (8080, 8081, 4317, 4318, 8888) is occupied by another process.

**Find what is using the port:**

```bash
# macOS / Linux
lsof -i :8080

# Windows (PowerShell)
netstat -ano | findstr :8080
```

**Change the port in `docker-compose.yml`:** Edit the `ports` mapping for the affected service. For example, to move order-service to port 9090:

```yaml
ports:
  - "9090:8080"   # host:container
```

Then update your curl commands to use `http://localhost:9090`.

### New Relic Data Not Appearing

Work through this checklist in order:

1. **Check `.env`** — confirm `NR_LICENSE_KEY` is set to a valid INGEST-LICENSE key (not an API key or User key).

2. **Check the Collector logs** for export errors:
   ```bash
   docker logs otelcol-agent 2>&1 | grep -iE "error|failed|403|401"
   ```

3. **Verify the endpoint** — US accounts must use `https://otlp.nr-data.net`, EU accounts must use `https://otlp.eu01.nr-data.net`. No port number in either case.

4. **Check Collector self-metrics** for failed exports:
   ```bash
   curl -s http://localhost:8888/metrics | grep otelcol_exporter_send_failed
   ```
   A non-zero value confirms export failures. The Collector logs will show the HTTP status code returned by New Relic.

5. **Confirm the app is sending telemetry** to the Collector:
   ```bash
   curl -s http://localhost:8888/metrics | grep otelcol_receiver_accepted_spans
   ```
   If this is `0`, the application is not reaching the Collector. Verify both containers are on the same Docker network with `docker network inspect otel-lab`.

6. **Wait longer** — on first run, or after a cold restart, data can take up to 90 seconds to appear in New Relic.

### Services Not Starting

If containers exit immediately after `docker compose up`:

```bash
# Check which containers are not running
docker compose ps

# View logs for a specific failing service
docker logs order-service
docker logs payment-service
docker logs otelcol-agent
```

Common causes:

- **Insufficient Docker memory:** Go to Docker Desktop → Settings → Resources → Memory. Set to at least 4096 MB and restart Docker Desktop.
- **Missing `.env` file:** If `.env` does not exist, Docker Compose cannot substitute variables and some containers will fail to start. Run `cp .env.example .env` and fill in the required values.
- **Config file not found:** If `COLLECTOR_CONFIG` references a file that does not exist, `otelcol-agent` will exit. Verify the filename in `configs/`.

### "otelcol-agent shows no health status" / "otelcol-gateway is missing"

These are expected, not bugs:

- **No health status on the collectors.** The collector-contrib image is distroless (no shell/`wget`), so the containers intentionally have **no** Docker `healthcheck`. `docker compose ps` shows them as `Up` (never `healthy`/`unhealthy`). Check liveness at `http://localhost:13133` instead. The app services (order/payment) still report `healthy`.
- **`otelcol-gateway` not listed by `docker compose ps`.** It is gated behind the `gateway` profile and is not started by a plain `docker compose up`. Start it only for the Module 9 exercise with `docker compose --profile gateway up -d`.

### Load Generator Too Aggressive

If the load generator is causing CPU or memory pressure, reduce the rate:

```bash
# Stop load generator
docker compose stop load-generator

# Restart at a lower rate
LOAD_RATE=2 docker compose up -d load-generator
```

### Docker Compose v1 vs v2

If you have the legacy `docker-compose` (v1) binary, replace `docker compose` with `docker-compose` in all commands. However, v1 is end-of-life. The recommended fix is to update Docker Desktop to 4.x, which bundles Compose v2 as a Docker CLI plugin.

**Verify your version:**

```bash
docker compose version   # v2 — correct
docker-compose version   # v1 — legacy, update if possible
```

### Resetting to a Clean State

If the lab environment is in an inconsistent state, do a full reset:

```bash
# Stop all containers and remove volumes
docker compose down -v

# Remove built images to force a fresh build
docker compose build --no-cache

# Start fresh
docker compose up -d
```

### Getting Help

If you encounter an issue not covered here:

1. Capture the Collector logs: `docker logs otelcol-agent > collector.log 2>&1`
2. Capture compose status: `docker compose ps > compose-status.txt`
3. Capture self-metrics: `curl -s http://localhost:8888/metrics > self-metrics.txt`
4. Share these three files with your instructor or the course Slack channel.
