#!/usr/bin/env bash
# =============================================================================
# generate-traffic.sh, send an on-demand burst of orders to order-service
# =============================================================================
# Usage: generate-traffic.sh [COUNT]   (default 50)
# Runs a short-lived curl pod inside the cluster so it can reach the
# order-service ClusterIP service directly. A continuous baseline load also
# runs via the load-generator Deployment; this is for generating a spike.
# =============================================================================
set -euo pipefail
COUNT="${1:-50}"

kubectl -n otel-lab run "traffic-burst-$$" \
  --rm -i --restart=Never --image=curlimages/curl:latest -- \
  sh -c "for i in \$(seq 1 ${COUNT}); do \
    curl -s -o /dev/null -X POST http://order-service.otel-lab.svc.cluster.local:8080/orders \
      -H 'Content-Type: application/json' \
      -d '{\"item\":\"widget\",\"quantity\":3,\"user_tier\":\"premium\",\"user_email\":\"jane.doe@example.com\"}'; \
  done; echo 'sent ${COUNT} orders to order-service'"
