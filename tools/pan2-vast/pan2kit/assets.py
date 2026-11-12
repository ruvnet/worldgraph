"""Verify the offline encoder revision actually selected by native PAN2."""
import json
from pathlib import Path


def verify_encoder(manifest):
    from huggingface_hub import snapshot_download
    records = json.loads(Path(manifest).read_text())
    repo = 'Qwen/Qwen3.5-9B'
    expected = records[repo]['revision']
    actual = Path(snapshot_download(repo, revision='main', local_files_only=True)).name
    if actual != expected:
        raise ValueError('Offline Qwen main cache differs from declared snapshot revision')
    return {'repo': repo, 'revision': actual}
