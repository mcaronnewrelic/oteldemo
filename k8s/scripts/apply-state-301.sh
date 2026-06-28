#!/usr/bin/env bash
# =============================================================================
# apply-state-301.sh, state machine for the OTel 301 advanced-pipelines lab.
# Mirrors apply-state.sh, but the gateway is a StatefulSet (multi-replica, for
# tail sampling at scale) and the payment-service can run on the New Relic APM
# agent or on OpenTelemetry (for the migration challenge).
#
# States:
#   cha-start  : tail sampling at scale, BROKEN  (agent routes by service)
#   cha-solved : tail sampling at scale, FIXED   (agent routes by traceID)
#   chb-start  : migration, START   (payment on the New Relic APM agent, no OTel)
#   chb-solved : migration, SOLVED  (payment migrated back to OpenTelemetry)
# =============================================================================
set -euo pipefail

LAB_DIR="${LAB_DIR:-/root/otel-lab}"
K8S="${LAB_DIR}/k8s"
NS=otel-lab
export KUBECONFIG="${KUBECONFIG:-/etc/rancher/k3s/k3s.yaml}"
STATE="${1:?usage: apply-state-301.sh <cha-start|cha-solved|chb-start|chb-solved>}"

load_agent() {   # $1 = source filename under k8s/collector/
  cp "${K8S}/collector/$1" "${K8S}/collector-agent.yaml"
  kubectl -n "${NS}" create configmap otel-agent-config \
    --from-file=config.yaml="${K8S}/collector-agent.yaml" \
    --dry-run=client -o yaml | kubectl apply -f - >/dev/null
}

load_gateway() { # $1 = source filename under k8s/collector/
  cp "${K8S}/collector/$1" "${K8S}/collector-gateway.yaml"
  kubectl -n "${NS}" create configmap otel-gateway-config \
    --from-file=config.yaml="${K8S}/collector-gateway.yaml" \
    --dry-run=client -o yaml | kubectl apply -f - >/dev/null
}

set_payment() {  # $1 = apm | otel
  case "$1" in
    apm)  kubectl apply -f "${K8S}/301/payment-apm.yaml"  >/dev/null ;;
    otel) kubectl apply -f "${K8S}/301/payment-otel.yaml" >/dev/null ;;
  esac
}

restart() { for w in "$@"; do kubectl -n "${NS}" rollout restart "$w" >/dev/null 2>&1 || true; done; }

echo "==> Applying 301 lab state: ${STATE}"
case "${STATE}" in
  cha-start)  load_gateway gateway-full.yaml; load_agent agent-lb-byservice.yaml; set_payment otel ;;
  cha-solved) load_gateway gateway-full.yaml; load_agent agent-lb-bytrace.yaml;   set_payment otel ;;
  chb-start)  load_gateway gateway-full.yaml; load_agent agent-lb-bytrace.yaml;   set_payment apm  ;;
  chb-solved) load_gateway gateway-full.yaml; load_agent agent-lb-bytrace.yaml;   set_payment otel ;;
  *) echo "Unknown state: ${STATE}" >&2; exit 1 ;;
esac

restart deployment/order-service deployment/payment-service statefulset/otel-gateway daemonset/otel-agent
for w in deployment/order-service deployment/payment-service statefulset/otel-gateway daemonset/otel-agent; do
  kubectl -n "${NS}" rollout status "$w" --timeout=150s >/dev/null 2>&1 || true
done
echo "==> 301 state ${STATE} applied."
