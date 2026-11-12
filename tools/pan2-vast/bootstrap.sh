#!/usr/bin/env bash
set -euo pipefail
python -c 'import sys; assert sys.version_info[:2] == (3,14), "Use Python 3.14 per pinned PAN2 environment"'
python -m pan2kit fetch --repo PAN2
python -m pip install torch==2.12.1 torchvision==0.27.1 --index-url https://download.pytorch.org/whl/cu132
python -m pip install --pre 'flash-attn-4[cu13]==4.0.0b29' --no-build-isolation
python -m pip install 'quack-kernels[cu13]==0.6.4'
python -m pip install -r PAN2/requirements.txt
python -m pip freeze > environment-installed.txt
python -m pan2kit doctor --repo PAN2
python -m unittest discover -s tests -v
