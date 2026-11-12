"""Bounded local experiment planning, execution and evidence based selection."""
import argparse
import json
import math
from pathlib import Path
import random
import re
import time
from pan2kit import PAN_COMMIT
from pan2kit.trial import atomic_json, digest, execute, verify_repo


def hashed(value):
    import hashlib
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()).hexdigest()


def number(value, name, minimum=0):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < minimum:
        raise ValueError('Invalid ' + name)
    return value


def integer(value, name, minimum=0):
    number(value, name, minimum)
    if not isinstance(value, int): raise ValueError('Expected integer ' + name)
    return value


def ident(value):
    if not isinstance(value, str) or not re.fullmatch(r'[A-Za-z0-9_]{1,64}', value):
        raise ValueError('IDs must be short letters, numbers or underscores')
    return value


def verify_inputs(inputs):
    for path, expected in inputs.items():
        if not Path(path).is_file() or digest(path) != expected:
            raise ValueError('Input hash changed: ' + path)


def make_plan(config, base):
    if config.get('schema') != 'pan2-metaharness/1': raise ValueError('Unsupported config schema')
    base = Path(base).resolve()
    def path(value): return str((base / value).resolve())
    repo, vae = path(config['repo']), path(config['vae'])
    variants, prompts, seeds = config['variants'], config['prompts'], config['seeds']
    if not 1 <= len(variants) <= 12 or not 1 <= len(prompts) <= 100 or not 1 <= len(seeds) <= 16:
        raise ValueError('Suite exceeds bounded size')
    if len(set(seeds)) != len(seeds): raise ValueError('Duplicate seeds')
    for seed in seeds: integer(seed, 'seed')
    settings = config['settings']
    for key in ['frames', 'height', 'width', 'steps']:
        integer(settings[key], key, 1)
    if (settings['frames'] - 1) % 8 or settings['height'] % 32 or settings['width'] % 32:
        raise ValueError('Use frames 8n+1 and dimensions divisible by32')
    timeout = integer(config['timeout_seconds'], 'timeout', 1)
    if timeout > 86400: raise ValueError('Timeout exceeds one day')
    rate = number(config['hourly_usd'], 'hourly rate', 0.000001)
    budget = number(config['budget_usd'], 'budget', 0.000001)
    overhead = number(config.get('setup_storage_transfer_usd', 0), 'overhead')
    if overhead >= budget: raise ValueError('Overhead exhausts budget')
    inputs = {}
    def bind(p):
        if not Path(p).is_file(): raise ValueError('Missing input: ' + p)
        if p not in inputs: inputs[p] = digest(p)
        return inputs[p]
    assets = path(config['assets_manifest'])
    bind(assets)
    asset_records = json.loads(Path(assets).read_text())
    asset_hash = hashed({name: entry['revision'] if isinstance(entry, dict) else entry
                         for name, entry in asset_records.items()})
    # Bind VAE bytes, not just its directory name. HF snapshot symlinks resolve locally.
    vae_files = sorted(p for p in Path(vae).rglob('*') if p.is_file())
    if not vae_files: raise ValueError('VAE directory has no files')
    vae_hash = hashed({str(p.relative_to(vae)): bind(str(p.resolve())) for p in vae_files})
    training = path(config.get('training_config', str(Path(repo) / 'config/sft_29B_720p.yaml')))
    training_hash = bind(training)
    v_ids, p_ids, jobs = set(), set(), []
    normalized_prompts = []
    for prompt in prompts:
        pid = ident(prompt['id'])
        if pid in p_ids: raise ValueError('Duplicate prompt ID')
        p_ids.add(pid); file = path(prompt['file']); phash = bind(file)
        text = Path(file).read_text().strip()
        if not text or len(text.encode()) > 65536: raise ValueError('Invalid prompt length')
        normalized_prompts.append((pid, phash, text))
    for variant in variants:
        vid = ident(variant['id'])
        if vid in v_ids: raise ValueError('Duplicate variant ID')
        v_ids.add(vid)
        bits = variant['bits']
        if type(bits) is not int or bits not in (0, 4, 8): raise ValueError('Invalid bit width')
        checkpoint = path(variant['checkpoint'])
        ckhash = bind(str(Path(checkpoint) / 'transformer/model.safetensors'))
        for pid, phash, text in normalized_prompts:
            for seed in seeds:
                case = hashed({'pan_commit': PAN_COMMIT, 'checkpoint': ckhash, 'prompt': phash,
                               'seed': seed, 'settings': settings, 'assets': asset_hash,
                               'vae': vae_hash, 'training': training_hash})
                jobs.append({'id': vid + '_' + pid + '_' + str(seed), 'variant': vid,
                             'case_sha256': case, 'repo': repo, 'vae': vae,
                             'checkpoint': checkpoint, 'bits': bits, 'prompt': text,
                             'seed': seed, 'training_config': training,
                             'timeout_seconds': timeout, **settings})
    order_seed = integer(config.get('order_seed', 42), 'order seed')
    random.Random(order_seed).shuffle(jobs)
    if len(jobs) > 512: raise ValueError('Plan exceeds 512 attempts')
    plan = {'schema': 'pan2-metaharness-plan/1', 'pan_commit': PAN_COMMIT,
            'hardware_label': ident(config['hardware_label']), 'inputs': inputs, 'jobs': jobs,
            'hourly_usd': rate, 'budget_usd': budget, 'overhead_usd': overhead,
            'order_seed': order_seed, 'quality_validation': 'pending'}
    validate_plan(plan)
    return plan


def validate_plan(plan):
    if plan.get('schema') != 'pan2-metaharness-plan/1' or plan.get('pan_commit') != PAN_COMMIT:
        raise ValueError('Invalid plan identity')
    number(plan['hourly_usd'], 'rate', 0.000001)
    number(plan['budget_usd'], 'budget', 0.000001)
    number(plan['overhead_usd'], 'overhead')
    if plan['overhead_usd'] >= plan['budget_usd']: raise ValueError('Budget exhausted')
    if not 1 <= len(plan['jobs']) <= 512: raise ValueError('Invalid job count')
    ids, cases = set(), set()
    for job in plan['jobs']:
        jid = job['id']
        if not isinstance(jid, str) or not re.fullmatch(r'[A-Za-z0-9_]{1,160}', jid) or jid in ids:
            raise ValueError('Invalid or duplicate job ID')
        ids.add(jid); ident(job['variant'])
        if type(job['bits']) is not int or job['bits'] not in (0,4,8): raise ValueError('Invalid bits')
        if not re.fullmatch(r'[0-9a-f]{64}', job['case_sha256']): raise ValueError('Invalid case hash')
        pair = (job['case_sha256'], job['bits'])
        if pair in cases: raise ValueError('Duplicate semantic job; use unique prompts and seeds')
        cases.add(pair)
        integer(job['seed'], 'seed')
        if integer(job['timeout_seconds'], 'timeout', 1) > 86400: raise ValueError('Timeout too large')
        for key in ('frames','height','width','steps'): integer(job[key], key, 1)
        if (job['frames']-1)%8 or job['height']%32 or job['width']%32: raise ValueError('Invalid dimensions')
        if len(job['prompt'].encode()) > 65536 or not job['prompt'].strip(): raise ValueError('Invalid prompt')
    if not plan['inputs'] or any(not re.fullmatch(r'[0-9a-f]{64}', h) for h in plan['inputs'].values()):
        raise ValueError('Invalid input identities')


def _run_plan(plan, output, resume=False):
    validate_plan(plan)
    output = Path(output).resolve()
    identity = hashed(plan)
    if resume:
        state = json.loads((output / 'run.json').read_text())
        if state.get('plan_sha256') != identity: raise ValueError('Resume plan changed')
        if state['status'] not in ('completed', 'budget_stopped'): raise ValueError('Failed or interrupted suites require a new output directory')
    else:
        output.mkdir(parents=True, exist_ok=False)
        atomic_json(output / 'plan.json', plan)
        state = {'schema': 'pan2-metaharness-run/1', 'plan_sha256': identity,
                 'status': 'running', 'input_integrity': 'pending', 'attempts': []}
    verify_repo(plan['jobs'][0]['repo']); verify_inputs(plan['inputs'])
    # Successful cached work must still have identical evidence before it can be reused.
    for item in state['attempts']:
        if item['status'] != 'completed': raise ValueError('Cannot reuse failed trial')
        trial = json.loads((output / item['id'] / 'trial.json').read_text())
        if hashed(trial) != item['trial_sha256'] or digest(output / item['id'] / 'output.mp4') != trial['output_sha256']:
            raise ValueError('Cached result was modified')
    done = {x['id'] for x in state['attempts']}
    # Estimated budget is local scheduling only; it does not stop Vast rental billing.
    used = plan['overhead_usd'] + sum(x['estimated_compute_usd'] for x in state['attempts'])
    state['status'] = 'running'
    atomic_json(output / 'run.json', state)
    try:
        for job in plan['jobs']:
            if job['id'] in done: continue
            reservation = job['timeout_seconds'] * plan['hourly_usd'] / 3600
            if used + reservation > plan['budget_usd']:
                state['status'] = 'budget_stopped'; break
            # Persist a running marker before launching; interruptions cannot appear completed.
            item = {'id': job['id'], 'status': 'running', 'estimated_compute_usd': reservation}
            state['attempts'].append(item); atomic_json(output / 'run.json', state)
            started = time.monotonic()
            result = execute(job, output / job['id'])
            elapsed = time.monotonic() - started
            cost = elapsed * plan['hourly_usd'] / 3600
            item.update(status=result['status'], estimated_compute_usd=cost,
                        trial_sha256=hashed(result), case_sha256=job['case_sha256'],
                        variant=job['variant'], bits=job['bits'])
            used += cost
            atomic_json(output / 'run.json', state)
            if result['status'] != 'completed':
                state['status'] = 'failed'; break
        else: state['status'] = 'completed'
    except BaseException:
        state['status'] = 'interrupted'
        raise
    finally:
        try:
            verify_repo(plan['jobs'][0]['repo'])
            verify_inputs(plan['inputs']); state['input_integrity'] = 'verified'
        except Exception:
            state['input_integrity'] = 'failed'; state['status'] = 'failed'
            raise
        finally:
            state['estimated_total_usd'] = used
            atomic_json(output / 'run.json', state)
    return state


def run_plan(plan, output, resume=False):
    # A local lock prevents concurrent resumes from launching the same jobs twice.
    import fcntl
    root = Path(output).resolve()
    if not root.parent.is_dir(): raise ValueError('Output parent must exist')
    with (root.parent / (root.name + '.lock')).open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return _run_plan(plan, output, resume)


def load_evidence(root, variant, reviews, billing):
    root = Path(root).resolve()
    plan = json.loads((root / 'plan.json').read_text())
    state = json.loads((root / 'run.json').read_text())
    if state['status'] != 'completed' or state['input_integrity'] != 'verified' or state['plan_sha256'] != hashed(plan):
        raise ValueError('Suite evidence incomplete or changed')
    validate_plan(plan)
    selected = [j for j in plan['jobs'] if j['variant'] == variant]
    if not selected: raise ValueError('Variant missing')
    attempts = {x['id']: x for x in state['attempts']}
    if len(attempts) != len(state['attempts']) or set(attempts) != {j['id'] for j in plan['jobs']}:
        raise ValueError('Missing or duplicate attempts')
    cases, total, accepted = {}, number(billing['shared_usd'], 'billed overhead'), 0
    for job in selected:
        item = attempts[job['id']]
        if item['status'] != 'completed': raise ValueError('Failed attempt')
        result = json.loads((root / job['id'] / 'trial.json').read_text())
        output_hash = digest(root / job['id'] / 'output.mp4')
        if hashed(result) != item['trial_sha256'] or result['status'] != 'completed' or result['output_sha256'] != output_hash:
            raise ValueError('Trial evidence changed')
        if result['worker'].get('bits') != job['bits']: raise ValueError('Worker precision mismatch')
        review = reviews[job['id']]
        if (review.get('output_sha256') != output_hash or type(review.get('accepted')) is not bool
                or type(review.get('critical_failure')) is not bool or not review.get('reviewer')):
            raise ValueError('Unbound or invalid review')
        if review['accepted'] and review['critical_failure']: raise ValueError('Contradictory review')
        total += number(billing['trials_usd'][job['id']], 'billed trial')
        case = job['case_sha256']
        if case in cases: raise ValueError('Duplicate comparison case')
        cases[case] = review
        accepted += review['accepted']
    return cases, total, accepted


def evaluate(baseline, candidate, base_variant, candidate_variant, reviews, billing):
    """Operator supplied bills/reviews are evidence inputs, not execution attestations."""
    b, bc, ba = load_evidence(baseline, base_variant, reviews['baseline'], billing['baseline'])
    c, cc, ca = load_evidence(candidate, candidate_variant, reviews['candidate'], billing['candidate'])
    bp = json.loads((Path(baseline)/'plan.json').read_text())
    cp = json.loads((Path(candidate)/'plan.json').read_text())
    if any(j['bits'] != 0 for j in bp['jobs'] if j['variant'] == base_variant): raise ValueError('Reference must be BF16')
    if any(j['bits'] not in (4,8) for j in cp['jobs'] if j['variant'] == candidate_variant): raise ValueError('Candidate must be quantized')
    if set(b) != set(c): raise ValueError('Comparison workloads or checkpoint identities differ')
    n = len(b)
    regressions = sum(b[k]['accepted'] and not c[k]['accepted'] for k in b)
    critical = sum(c[k]['critical_failure'] and not b[k]['critical_failure'] for k in b)
    # Conservative one sided 95% Wilson bound on newly rejected cases; no credit for gains.
    z = 1.6448536269514722
    p = regressions / n
    upper = (p + z*z/(2*n) + z*math.sqrt(p*(1-p)/n + z*z/(4*n*n))) / (1+z*z/n)
    saving = None if ba == 0 or ca == 0 or bc <= 0 else 1 - (cc / ca) / (bc / ba)
    status = 'inconclusive'
    if critical or ba == 0 or ca == 0 or (saving is not None and saving < 0.30): status = 'rejected'
    elif n >= 30 and upper <= 0.05 and saving is not None: status = 'accepted_for_generation'
    return {'schema': 'pan2-metaharness-decision/1', 'status': status, 'cases': n,
            'new_rejections': regressions, 'new_critical_failures': critical,
            'new_rejection_rate_upper_95': upper, 'baseline_cost_per_accepted_usd': bc/ba if ba else None,
            'candidate_cost_per_accepted_usd': cc/ca if ca else None,
            'saving_fraction': saving, 'physical_promotion_allowed': False,
            'review_sha256': hashed(reviews), 'billing_sha256': hashed(billing),
            'evidence_trust': 'local operator assertions; no remote attestation',
            'automatic_promotion': False,
            'baseline_plan_sha256': hashed(bp), 'candidate_plan_sha256': hashed(cp),
            'baseline_variant': base_variant, 'candidate_variant': candidate_variant}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    p = sub.add_parser('plan'); p.add_argument('--config', required=True); p.add_argument('--output', required=True)
    p = sub.add_parser('run'); p.add_argument('--plan', required=True); p.add_argument('--output', required=True); p.add_argument('--resume', action='store_true')
    p = sub.add_parser('evaluate')
    for key in ['baseline', 'candidate', 'base-variant', 'candidate-variant', 'reviews', 'billing', 'output']:
        p.add_argument('--'+key, required=True)
    args = parser.parse_args()
    if args.command == 'plan':
        config_path = Path(args.config).resolve()
        value = make_plan(json.loads(config_path.read_text()), config_path.parent)
        validate_plan(value)
    elif args.command == 'run':
        value = run_plan(json.loads(Path(args.plan).read_text()), args.output, args.resume)
        print(json.dumps(value, indent=2))
        if value['status'] != 'completed': raise SystemExit(1)
        return
    else:
        value = evaluate(args.baseline, args.candidate, args.base_variant, args.candidate_variant,
                         json.loads(Path(args.reviews).read_text()), json.loads(Path(args.billing).read_text()))
    if Path(args.output).exists(): raise FileExistsError(args.output)
    atomic_json(args.output, value)
    print(json.dumps(value, indent=2))
    if args.command == 'evaluate' and value['status'] != 'accepted_for_generation': raise SystemExit(1)

if __name__ == '__main__': main()
