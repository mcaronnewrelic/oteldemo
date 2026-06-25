# Kubernetes overlay for the OpenTelemetry 201 capstone lab

This directory backs the **OpenTelemetry 201: Operating Production Pipelines**
Instruqt track (`otel-201-production-pipelines`). The 101 lab runs this same
`order-service` / `payment-service` app on Docker Compose; the 201 lab runs it on
a single-node k3s cluster so learners work with real production topology (an
agent DaemonSet plus a gateway, Kubernetes metadata, container log collection).

## Layout

```
k8s/
  base/                     # the SOLVED / final state of the whole track
    00-namespace-rbac.yaml  # namespace otel-lab + RBAC for k8sattributes
    20-app.yaml             # order-service + payment-service (source hot-reloaded)
    30-otel-agent.yaml      # agent DaemonSet: OTLP + filelog + k8sattributes + PII redaction → gateway
    40-otel-gateway.yaml    # gateway: filter, transform, tail sampling, spanmetrics → New Relic
    50-load-generator.yaml  # continuous baseline traffic
  challenge-01..05/         # per-challenge STARTING state (regressions of base)
  variants/                 # app source variants for the code-edit challenges
  scripts/
    generate-traffic.sh     # on-demand traffic burst
    apply-state.sh          # put the cluster into a named challenge state
```

## State model

`base/` is the end state of the entire track: app fully instrumented, agent and
gateway fully built. Each challenge's **starting state** is a deliberate
regression of the base:

| Challenge | Starting state (what is broken or missing) |
|-----------|--------------------------------------------|
| 01 Instrumentation | `process-order` manual span + custom attributes stripped; outbound propagation broken so the trace fragments |
| 02 Collector pipeline | gateway is minimal (no filter, transform, tail sampling, or spanmetrics); agent exports straight to New Relic |
| 03 Logs | agent has no `filelog` receiver, so logs are not collected, correlated, or redacted |
| 04 Health & cost | gateway has no self-metrics export and no tail sampling; a high-cardinality attribute is inflating metrics |
| 05 Capstone | several of the above faults injected at once |

The Instruqt lifecycle scripts drive this:
- **setup** applies the challenge's starting state (`apply-state.sh <NN> start`)
- **solve** applies the solved state (`apply-state.sh <NN> solved`)
- **check** verifies the outcome in New Relic via NerdGraph

## How the app is run (hot reload)

The container images carry the dependencies; the repo's `demo-app/` directory is
bind-mounted from the k3s node into `/app/src`, and each service runs under a file
watcher (`nodemon` for Node, `watchmedo` for Python). Editing the source in the
Instruqt "App source" tab hot-reloads the service, so the code-edit challenges
need no image rebuild. `nodemon` and `watchdog` are listed as app dependencies
for this reason; the Docker Compose (101) lab keeps its default `node` / `python`
start command and is unaffected.

## Telemetry destination

Only the **gateway** exports to New Relic, using the `newrelic` Secret
(`license-key`, `otlp-endpoint`) that the track setup script creates from the
lab's `NR_LICENSE_KEY` / `NR_OTLP_ENDPOINT`. The agent forwards to the gateway
over OTLP and never talks to New Relic directly.
