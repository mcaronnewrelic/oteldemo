#!/usr/bin/env bash
# =============================================================================
# apply-state.sh, drive the cluster into a named challenge state
# =============================================================================
# Usage: apply-state.sh <state>
#   states: ch01-start ch01-solved ch02-start ch02-solved ch03-start ch03-solved
#           ch04-start ch04-solved ch05-start ch05-solved base
#
# Each state sets four things:
#   - the otel-agent collector config   (copied to the editable k8s/collector-agent.yaml)
#   - the otel-gateway collector config (copied to the editable k8s/collector-gateway.yaml)
#   - the otel-gateway replica count    (0 before the gateway is built in challenge 02)
#   - the order-service source variant  (for the code-edit challenges)
#
# The editable active configs live at k8s/collector-agent.yaml and
# k8s/collector-gateway.yaml; learners edit those and run `apply-config`.
# The per-state source configs live under k8s/collector/.
# =============================================================================
set -euo pipefail

LAB_DIR="${LAB_DIR:-/root/otel-lab}"
K8S="${LAB_DIR}/k8s"
NS=otel-lab
export KUBECONFIG="${KUBECONFIG:-/etc/rancher/k3s/k3s.yaml}"
STATE="${1:?usage: apply-state.sh <state>}"

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
set_gateway_replicas() { kubectl -n "${NS}" scale deployment/otel-gateway --replicas="$1" >/dev/null; }
set_app() {
  case "$1" in
    canonical)  git -C "${LAB_DIR}" checkout -- demo-app/order-service.js ;;
    ch01-start) cp "${K8S}/variants/order-service.ch01-start.js" "${LAB_DIR}/demo-app/order-service.js" ;;
    ch05-faults)
      git -C "${LAB_DIR}" checkout -- demo-app/order-service.js
      f="${LAB_DIR}/demo-app/order-service.js"
      perl -i -pe 's/const \{ trace, context, SpanStatusCode \}/const { trace, context, ROOT_CONTEXT, SpanStatusCode }/' "$f"
      perl -i -pe 's/paymentResult = await callPaymentService\(orderId, amount, currency\);/paymentResult = await context.with(ROOT_CONTEXT, () => callPaymentService(orderId, amount, currency));/' "$f"
      ;;
  esac
}
restart() { for w in "$@"; do kubectl -n "${NS}" rollout restart "$w" >/dev/null 2>&1 || true; done; }

echo "==> Applying lab state: ${STATE}"
case "${STATE}" in
  ch01-start)            set_gateway_replicas 0; load_agent agent-direct.yaml;       load_gateway gateway-min.yaml;      set_app ch01-start ;;
  ch01-solved|ch02-start) set_gateway_replicas 1; load_agent agent-direct.yaml;      load_gateway gateway-min.yaml;      set_app canonical ;;
  ch02-solved|ch03-start) set_gateway_replicas 1; load_agent agent-gateway.yaml;     load_gateway gateway-pipeline.yaml; set_app canonical ;;
  ch03-solved|ch04-start) set_gateway_replicas 1; load_agent agent-full.yaml;        load_gateway gateway-pipeline.yaml; set_app canonical ;;
  ch04-solved|base|ch05-solved) set_gateway_replicas 1; load_agent agent-full.yaml;  load_gateway gateway-full.yaml;     set_app canonical ;;
  ch05-start)            set_gateway_replicas 1; load_agent agent-ch05-faults.yaml;  load_gateway gateway-ch05-faults.yaml; set_app ch05-faults ;;
  *) echo "Unknown state: ${STATE}" >&2; exit 1 ;;
esac

restart deployment/order-service deployment/payment-service deployment/otel-gateway daemonset/otel-agent
# Wait for every workload to finish rolling out so the new config/code is actually
# live before the solve wait and the (short) absence-check windows in the checks.
for w in deployment/order-service deployment/payment-service deployment/otel-gateway daemonset/otel-agent; do
  kubectl -n "${NS}" rollout status "$w" --timeout=120s >/dev/null 2>&1 || true
done
echo "==> State ${STATE} applied."
