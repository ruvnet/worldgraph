#!/usr/bin/env bash
# Prepare a rented GPU host for PAN 2 inference (ADR-208).
#
# Runs ON the GPU host. Installs the pinned upstream environment, downloads
# the released weights, and converts them for upstream generate.py. Nothing
# here modifies upstream code. Re-running skips finished steps.
#
#   PAN2_COMMIT   upstream ifm-ai/PAN2 commit to check out   (required)
#   PAN2_REVISION Hugging Face revision of IFM/PAN2          (required)
#   WORK          working directory                          (default /workspace/pan2)
set -euo pipefail

: "${PAN2_COMMIT:?set PAN2_COMMIT}" "${PAN2_REVISION:?set PAN2_REVISION}"
WORK=${WORK:-/workspace/pan2}
export HF_HOME="$WORK/hf"
export HF_HUB_ENABLE_HF_TRANSFER=0
mkdir -p "$WORK" "$HF_HOME"
cd "$WORK"
step() { printf '\n[%s] === %s ===\n' "$(date -u +%FT%TZ)" "$*"; }

step "system packages"
if ! command -v git >/dev/null || ! command -v gcc >/dev/null || ! command -v ffmpeg >/dev/null; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq git build-essential curl ca-certificates ffmpeg rsync >/dev/null
fi
nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader

step "conda"
if [[ ! -x "$WORK/conda/bin/conda" ]]; then
  curl -fsSL -o miniforge.sh https://github.com/conda-forge/miniforge/releases/latest/download/Miniforge3-Linux-x86_64.sh
  bash miniforge.sh -b -p "$WORK/conda" >/dev/null
  rm miniforge.sh
fi
export PATH="$WORK/conda/bin:$PATH"

step "upstream checkout at $PAN2_COMMIT"
if [[ ! -d PAN2/.git ]]; then git clone -q https://github.com/ifm-ai/PAN2.git; fi
git -C PAN2 fetch -q origin
git -C PAN2 checkout -q "$PAN2_COMMIT"
git -C PAN2 rev-parse HEAD

step "python environment (upstream scripts/install_h200.sh)"
if [[ ! -x "$WORK/conda/envs/pan2-h200/bin/torchrun" ]]; then
  CONDA_ENV=pan2-h200 bash PAN2/scripts/install_h200.sh
fi
ENV="$WORK/conda/envs/pan2-h200"

step "weights: IFM/PAN2@$PAN2_REVISION transformer"
"$ENV/bin/hf" download IFM/PAN2 --revision "$PAN2_REVISION" --include "transformer/*" --local-dir "$WORK/PAN2-weights" >/dev/null
step "frozen components: Qwen3.5-9B text encoder, Wan 2.2 VAE"
"$ENV/bin/hf" download Qwen/Qwen3.5-9B >/dev/null
"$ENV/bin/hf" download Wan-AI/Wan2.2-TI2V-5B-Diffusers >/dev/null
du -sh "$WORK/PAN2-weights" "$HF_HOME"

step "convert released weights to the native layout"
if [[ ! -d "$WORK/native/transformer" ]]; then
  (cd PAN2 && "$ENV/bin/python" scripts/convert_checkpoint.py to-native \
      --input "$WORK/PAN2-weights/transformer" --output "$WORK/native/transformer")
fi
ls -la "$WORK/native/transformer" | head
step "ready"
df -h "$WORK" | tail -1
