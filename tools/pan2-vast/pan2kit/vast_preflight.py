"""Read only Vast admission check. Never rents, starts or stops an instance."""
import argparse
import json
import os
from pathlib import Path
import urllib.error
import urllib.request
from pan2kit.trial import atomic_json

ENDPOINT = 'https://cloud.vast.ai/api/v0/instances/'

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def preflight():
    key = os.environ.get('VAST_API_KEY', '').strip()
    if not key:
        return {'schema': 'pan2-vast-admission/1', 'status': 'blocked',
                'reason': 'VAST_API_KEY_NOT_IN_EXECUTION_ENVIRONMENT',
                'api_called': False, 'new_spend_usd': 0, 'gpu_e2e': 'not_started'}
    request = urllib.request.Request(ENDPOINT, headers={'Authorization': 'Bearer ' + key})
    try:
        with urllib.request.build_opener(NoRedirect()).open(request, timeout=20) as response:
            payload = json.loads(response.read(4*1024*1024 + 1))
        instances = payload.get('instances')
        if not isinstance(instances, list): raise ValueError('Invalid instance response')
        # Never return endpoints, access URLs, environment values or authentication data.
        fields = ['id', 'actual_status', 'gpu_name', 'num_gpus', 'gpu_ram', 'dph_total', 'disk_space']
        return {'schema': 'pan2-vast-admission/1', 'status': 'inventory_verified',
                'api_called': True, 'instances': [{k: row[k] for k in fields if k in row} for row in instances],
                'gpu_e2e': 'pending_ssh_and_budget_admission'}
    except urllib.error.HTTPError as error:
        return {'schema':'pan2-vast-admission/1','status':'blocked','api_called':True,
                'reason':'VAST_HTTP_'+str(error.code),'gpu_e2e':'not_started'}
    except Exception:
        # Remote bodies and exception text may contain access material; do not echo them.
        return {'schema':'pan2-vast-admission/1','status':'blocked','api_called':True,
                'reason':'VAST_REQUEST_OR_SCHEMA_FAILED','gpu_e2e':'not_started'}


def main():
    p=argparse.ArgumentParser(description=__doc__); p.add_argument('--output',required=True)
    args=p.parse_args()
    if Path(args.output).exists(): raise FileExistsError(args.output)
    result=preflight(); atomic_json(args.output,result); print(json.dumps(result,indent=2))
    if result['status']!='inventory_verified': raise SystemExit(2)

if __name__=='__main__': main()
