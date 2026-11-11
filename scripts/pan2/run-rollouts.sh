#!/usr/bin/env bash
# Generate PAN 2 rollouts on a prepared GPU host and accept them locally (ADR-207).
#
#   scripts/pan2/run-rollouts.sh <user@host> <ssh port> <out dir> <plan.json>...
#
# For each plan this writes <out dir>/<plan file name without .json>/ as a
# verified `worldgraph.simulated.rollout` bundle. An image-to-video plan must
# have its image next to the plan as <plan name>.png (or .jpg).
#
# The GPU host must already have run scripts/pan2/remote-setup.sh and hold the
# static pan2-worker at $WORK/bin/pan2-worker. This script does not rent,
# stop or destroy any machine.
#
#   SSH_KEY        private key for the host           (default ~/.ssh/id_ed25519)
#   WORK           remote working directory           (default /workspace/pan2)
#   PAN2_COMMIT    upstream commit the host checked out            (required)
#   PAN2_REVISION  Hugging Face revision of the weights on the host (required)
#   STEPS          sampler steps                      (default 50, the released setting)
#   TIMEOUT_MIN    limit for one clip, model load included (default 120)
set -euo pipefail

target=${1:?user@host}; port=${2:?ssh port}; out=${3:?output directory}; shift 3
(( $# > 0 )) || { echo "give at least one plan" >&2; exit 2; }
: "${PAN2_COMMIT:?set PAN2_COMMIT}" "${PAN2_REVISION:?set PAN2_REVISION}"
key=${SSH_KEY:-$HOME/.ssh/id_ed25519}
work=${WORK:-/workspace/pan2}
repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
state=$(mktemp -d)
socket=$state/pan2.sock
media=$out/.media
ssh_opts=(-i "$key" -p "$port" -o ServerAliveInterval=30 -o StrictHostKeyChecking=accept-new ${SSH_KNOWN_HOSTS:+-o UserKnownHostsFile=$SSH_KNOWN_HOSTS})
remote() { ssh "${ssh_opts[@]}" "$target" "$@"; }
rollout() { "$repo/target/release/pan2-rollout" "$@"; }

cargo build --quiet --release --manifest-path "$repo/Cargo.toml" -p worldgraph-pan2 --bin pan2-rollout
mkdir -p "$out" "$media" "$out/.envelopes"

echo "== starting worker on $target"
remote "mkdir -p $work/media $work/images
  pgrep -x pan2-worker >/dev/null || (HF_HOME=$work/hf nohup $work/bin/pan2-worker \
    --socket $work/pan2.sock --media-root $work/media --image-root $work/images \
    --pan-root $work/PAN2 --torchrun $work/conda/envs/pan2-h200/bin/torchrun \
    --checkpoint $work/native/transformer --steps ${STEPS:-50} \
    --model-revision $PAN2_REVISION --runtime-commit $PAN2_COMMIT \
    > $work/worker.log 2>&1 < /dev/null &)
  for i in \$(seq 50); do test -S $work/pan2.sock && exit 0; sleep 0.2; done
  cat $work/worker.log; exit 1"

ssh "${ssh_opts[@]}" -N -L "$socket:$work/pan2.sock" "$target" &
forward=$!
trap 'kill $forward 2>/dev/null || true; rm -rf "$state"' EXIT
for _ in $(seq 100); do [[ -S $socket ]] && break; sleep 0.1; done
[[ -S $socket ]] || { echo "socket forward did not come up" >&2; exit 1; }

for plan in "$@"; do
  name=$(basename "$plan" .json)
  image=""
  for extension in png jpg jpeg; do
    [[ -f ${plan%.json}.$extension ]] && image=${plan%.json}.$extension
  done
  echo "== $name"
  if [[ -n $image ]]; then
    # The plan names the file the worker looks for; upload it under that name.
    remote_name=$(sed -n 's/.*"file"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$plan" | head -1)
    scp -q -i "$key" -P "$port" ${SSH_KNOWN_HOSTS:+-o UserKnownHostsFile=$SSH_KNOWN_HOSTS} "$image" "$target:$work/images/$remote_name"
  fi
  started=$(date +%s)
  rollout generate --plan "$plan" --socket "$socket" --hosted --accept-terms \
    --timeout-min "${TIMEOUT_MIN:-120}" --out "$out/.envelopes/$name.json"
  echo "   generated in $(( $(date +%s) - started )) s (model load included)"
  rsync -a -e "ssh ${ssh_opts[*]}" "$target:$work/media/" "$media/"
  rollout accept --plan "$plan" --envelope "$out/.envelopes/$name.json" \
    --media-root "$media" --out "$out/$name" ${image:+--first-frame "$image"} > "$out/$name.graph-node.json"
  rollout verify "$out/$name"
done
echo "== done: bundles in $out"
