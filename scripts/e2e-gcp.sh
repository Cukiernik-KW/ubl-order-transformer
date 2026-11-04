#!/usr/bin/env bash
# Manual, readable end-to-end run against the deployed stack (for demos and the README).
# Publishes a valid, an invalid and 5 copies of one message, then shows what reached each output
# topic and the service's log lines for each messageId. Uses the active gcloud project and account.
#
#   bash scripts/e2e-gcp.sh
set -euo pipefail
cd "$(dirname "$0")/.."

RUN=$(date +%s)
VALID="demo-valid-$RUN"
INVALID="demo-invalid-$RUN"
DUP="demo-duplicate-$RUN"

# A sample message with its messageId replaced (keeps the sample's document).
message() {
  node -e 'const m = require(process.argv[1]); m.messageId = process.argv[2]; process.stdout.write(JSON.stringify(m));' \
    "./samples/$1" "$2"
}

# Pulls (and acks) from an ops subscription for up to $3 seconds; prints attributes + body of our messages.
show() {
  local subscription="$1" pattern="$2" seconds="$3" end=$((SECONDS + $3)) out=""
  while [ $SECONDS -lt $end ]; do
    out+=$(gcloud pubsub subscriptions pull "$subscription" --auto-ack --limit=20 --format=json |
      node -e '
        const rows = JSON.parse(require("fs").readFileSync(0, "utf8"));
        for (const { message: m } of rows) {
          if (!new RegExp(process.argv[1]).test(m.attributes?.messageId ?? "")) continue;
          console.log("attributes: " + JSON.stringify(m.attributes));
          console.log(JSON.stringify(JSON.parse(Buffer.from(m.data, "base64").toString()), null, 2));
        }' "$pattern")$'\n'
  done
  echo "$out" | sed '/^$/d'
}

echo "== Publishing to orders.ubl.received"
gcloud pubsub topics publish orders.ubl.received --message="$(message message.valid.json "$VALID")" >/dev/null
echo "   valid:     $VALID"
gcloud pubsub topics publish orders.ubl.received --message="$(message message.missing-order-id.json "$INVALID")" >/dev/null
echo "   invalid:   $INVALID (no Order ID)"
for _ in 1 2 3 4 5; do
  gcloud pubsub topics publish orders.ubl.received --message="$(message message.valid.json "$DUP")" >/dev/null &
done
wait
echo "   duplicate: $DUP (5 copies, published concurrently)"

echo
echo "== orders.transformed (expect: $VALID once, $DUP once)"
show orders.transformed.ops "^demo-(valid|duplicate)-$RUN$" 30

echo
echo "== orders.failed (expect: $INVALID, failureSource=app)"
show orders.failed.ops "^$INVALID$" 10

echo
echo "== Cloud Logging: one summary line per delivery"
gcloud logging read \
  "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"ubl-order-transformer\" AND jsonPayload.outcome:* AND jsonPayload.messageId=~\"-$RUN$\"" \
  --freshness=10m --order=asc \
  --format="table(timestamp,jsonPayload.messageId,jsonPayload.outcome,jsonPayload.deliveryAttempt,jsonPayload.durationMs)"
