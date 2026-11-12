#!/usr/bin/env bash
# Ask a Vast serverless PAN2 endpoint for one clip. Waits through a cold start.
# Usage: request.sh <endpoint-name> <out.mp4> ['{"prompt":"...","seed":42}']
# Reads the account key from VAST_API_KEY or ~/.config/vastai/vast_api_key. Prints timings, never the key.
set -euo pipefail
NAME="$1"; OUT="$2"
DEFAULT_BODY='{"prompt":"a red ball bounces on a wooden floor","seed":42}'
BODY="${3:-$DEFAULT_BODY}"
KEY="${VAST_API_KEY:-$(cat ~/.config/vastai/vast_api_key)}"
ROUTER="${VAST_SERVERLESS_URL:-https://run.vast.ai}"
WAIT="${PAN2_WAIT_SECONDS:-2400}"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
curl -fsS -o "$TMP/vast.cer" https://console.vast.ai/static/jvastai_root.cer
start=$(date +%s); idx=0
while :; do
  curl -sS -m 30 -X POST "$ROUTER/route/" -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
    -d "$(jq -n --arg e "$NAME" --arg k "$KEY" --argjson i "$idx" '{endpoint:$e, api_key:$k, cost:9, request_idx:$i, replay_timeout:60}')" > "$TMP/route.json" || true
  idx=$(jq -r '.request_idx // 0' "$TMP/route.json" 2>/dev/null || echo 0)
  url=$(jq -r '.url // empty' "$TMP/route.json" 2>/dev/null || true)
  [ -n "$url" ] && break
  el=$(( $(date +%s) - start ))
  [ "$el" -gt "$WAIT" ] && { echo "no worker after ${el}s: $(jq -c 'del(.signature)' "$TMP/route.json" 2>/dev/null | cut -c1-300)" >&2; exit 2; }
  sleep 15
done
routed=$(( $(date +%s) - start ))
jq -n --slurpfile a "$TMP/route.json" --argjson p "$BODY" '{auth_data:$a[0], payload:$p}' > "$TMP/req.json"
code=$(curl -sS -m 1500 --cacert "$TMP/vast.cer" -o "$TMP/resp.json" -w '%{http_code}' -X POST "${url%/}/generate" \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' -d @"$TMP/req.json")
total=$(( $(date +%s) - start ))
if [ "$code" != 200 ]; then echo "worker returned HTTP $code: $(cut -c1-400 "$TMP/resp.json")" >&2; exit 3; fi
jq -r '.video_b64' "$TMP/resp.json" | base64 -d > "$OUT"
jq -c --argjson r "$routed" --argjson t "$total" 'del(.video_b64) + {wait_for_worker_s:$r, total_s:$t}' "$TMP/resp.json"
