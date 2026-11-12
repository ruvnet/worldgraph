import copy
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from pan2kit.metaharness import make_plan, validate_plan, run_plan, evaluate, hashed
from pan2kit.trial import atomic_json, digest, command, execute


def fixture(root, count=1, bits=(0,4)):
    (root/'repo/config').mkdir(parents=True, exist_ok=True)
    (root/'repo/config/sft_29B_720p.yaml').write_text('model: fixed')
    (root/'vae').mkdir(exist_ok=True); (root/'vae/config.json').write_text('{}')
    (root/'checkpoint/transformer').mkdir(parents=True,exist_ok=True)
    (root/'checkpoint/transformer/model.safetensors').write_bytes(b'checkpoint')
    (root/'assets.json').write_text('{"revision":"fixed"}')
    prompts=[]
    for i in range(count):
        (root/f'prompt{i}.txt').write_text(f'Object case {i}')
        prompts.append({'id':f'p{i}','file':f'prompt{i}.txt'})
    return {'schema':'pan2-metaharness/1','repo':'repo','vae':'vae','assets_manifest':'assets.json',
            'hardware_label':'test_gpu','variants':[{'id':f'v{b}','checkpoint':'checkpoint','bits':b} for b in bits],
            'prompts':prompts,'seeds':[42],'settings':{'frames':9,'height':256,'width':448,'steps':4},
            'hourly_usd':1,'budget_usd':20,'timeout_seconds':60}


def fake_execute(job, output):
    output=Path(output); output.mkdir()
    (output/'output.mp4').write_bytes(job['id'].encode())
    result={'status':'completed','worker':{'bits':job['bits']},'output_sha256':digest(output/'output.mp4')}
    atomic_json(output/'trial.json',result)
    return result


def reviews_for(root):
    plan=json.loads((root/'plan.json').read_text())
    return {j['id']:{'output_sha256':digest(root/j['id']/'output.mp4'),'accepted':True,
                     'critical_failure':False,'reviewer':'blind_reviewer'} for j in plan['jobs']}


class HarnessTests(unittest.TestCase):
    def test_encoder_revision_mismatch_rejected(self):
        import sys
        from types import SimpleNamespace
        from pan2kit.assets import verify_encoder
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/'assets.json'
            p.write_text(json.dumps({'Qwen/Qwen3.5-9B':{'revision':'expected'}}))
            with patch.dict(sys.modules,{'huggingface_hub':SimpleNamespace(snapshot_download=lambda *a,**kw:'/cache/other')}):
                with self.assertRaises(ValueError): verify_encoder(p)
            with patch.dict(sys.modules,{'huggingface_hub':SimpleNamespace(snapshot_download=lambda *a,**kw:'/cache/expected')}):
                self.assertEqual(verify_encoder(p)['revision'],'expected')

    def test_unique_seeded_schedule_and_quant_only_command(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d); cfg=fixture(root,bits=(4,8))
            plan=make_plan(cfg,root); validate_plan(plan)
            self.assertEqual(plan,make_plan(cfg,root))
            self.assertEqual(len(plan['jobs']),2)
            self.assertTrue(all(j['bits'] in (4,8) for j in plan['jobs']))
            argv=command(plan['jobs'][0],root/'out')
            self.assertEqual(argv[argv.index('--bits')+1],str(plan['jobs'][0]['bits']))
            bad=copy.deepcopy(plan); bad['jobs'][0]['id']='../escape'
            with self.assertRaises(ValueError): validate_plan(bad)
            cfg['hourly_usd']=float('nan')
            with self.assertRaises(ValueError): make_plan(cfg,root)

    def test_budget_stops_before_launch(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d); cfg=fixture(root); cfg['budget_usd']=0.001
            plan=make_plan(cfg,root)
            with patch('pan2kit.metaharness.verify_repo'),patch('pan2kit.metaharness.execute') as worker:
                state=run_plan(plan,root/'out')
            self.assertEqual(state['status'],'budget_stopped'); worker.assert_not_called()

    def test_resume_reuses_success_and_rejects_corruption(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d); plan=make_plan(fixture(root),root)
            with patch('pan2kit.metaharness.verify_repo'),patch('pan2kit.metaharness.execute',side_effect=fake_execute) as worker:
                self.assertEqual(run_plan(plan,root/'out')['status'],'completed')
                run_plan(plan,root/'out',resume=True)
                self.assertEqual(worker.call_count,2)
                job=plan['jobs'][0]; (root/'out'/job['id']/'output.mp4').write_bytes(b'corrupt')
                with self.assertRaises(ValueError): run_plan(plan,root/'out',resume=True)

    def test_input_mutation_and_worker_failure_stop(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d); plan=make_plan(fixture(root),root)
            def fail(job,out):
                result=fake_execute(job,out); result['status']='failed'
                atomic_json(Path(out)/'trial.json',result); return result
            with patch('pan2kit.metaharness.verify_repo'),patch('pan2kit.metaharness.execute',side_effect=fail) as worker:
                state=run_plan(plan,root/'out')
                self.assertEqual(state['status'],'failed'); self.assertEqual(worker.call_count,1)
                with self.assertRaises(ValueError): run_plan(plan,root/'out',resume=True)
            (root/'prompt0.txt').write_text('changed')
            with patch('pan2kit.metaharness.verify_repo'):
                with self.assertRaises(ValueError): run_plan(plan,root/'changed')

    def test_paired_cost_gate_and_evidence_binding(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d); cfg=fixture(root,count=100)
            plan=make_plan(cfg,root)
            with patch('pan2kit.metaharness.verify_repo'),patch('pan2kit.metaharness.execute',side_effect=fake_execute):
                run_plan(plan,root/'out')
            review=reviews_for(root/'out')
            reviews={'baseline':copy.deepcopy(review),'candidate':copy.deepcopy(review)}
            bills={'baseline':{'shared_usd':0,'trials_usd':{k:1 for k in review}},
                   'candidate':{'shared_usd':0,'trials_usd':{k:0.5 for k in review}}}
            result=evaluate(root/'out',root/'out','v0','v4',reviews,bills)
            self.assertEqual(result['status'],'accepted_for_generation')
            self.assertEqual(result['saving_fraction'],0.5)
            self.assertFalse(result['physical_promotion_allowed'])
            self.assertFalse(result['automatic_promotion'])
            jid=next(k for k in review if k.startswith('v4_'))
            reviews['candidate'][jid].update(accepted=False,critical_failure=True)
            self.assertEqual(evaluate(root/'out',root/'out','v0','v4',reviews,bills)['status'],'rejected')
            reviews['candidate'][jid]['output_sha256']='bad'
            with self.assertRaises(ValueError): evaluate(root/'out',root/'out','v0','v4',reviews,bills)

    def test_small_sample_is_inconclusive_and_cost_rejects(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d); plan=make_plan(fixture(root,count=3),root)
            with patch('pan2kit.metaharness.verify_repo'),patch('pan2kit.metaharness.execute',side_effect=fake_execute): run_plan(plan,root/'out')
            r=reviews_for(root/'out'); reviews={'baseline':r,'candidate':r}
            bills={'baseline':{'shared_usd':0,'trials_usd':{k:1 for k in r}},'candidate':{'shared_usd':0,'trials_usd':{k:0.5 for k in r}}}
            self.assertEqual(evaluate(root/'out',root/'out','v0','v4',reviews,bills)['status'],'inconclusive')
            bills['candidate']['trials_usd']={k:2 for k in r}
            self.assertEqual(evaluate(root/'out',root/'out','v0','v4',reviews,bills)['status'],'rejected')
            bills['candidate']['shared_usd']=float('nan')
            with self.assertRaises(ValueError): evaluate(root/'out',root/'out','v0','v4',reviews,bills)

    def test_real_trial_boundary_rejects_missing_output_and_kills_timeout(self):
        import subprocess
        with tempfile.TemporaryDirectory() as d:
            root=Path(d); job=make_plan(fixture(root),root)['jobs'][0]
            with patch('pan2kit.trial.subprocess.Popen') as proc:
                proc.return_value.wait.return_value=0
                self.assertEqual(execute(job,root/'missing')['status'],'failed')
            with patch('pan2kit.trial.subprocess.Popen') as proc,patch('pan2kit.trial.os.killpg') as kill:
                proc.return_value.pid=123
                proc.return_value.wait.side_effect=[subprocess.TimeoutExpired('worker',60),0]
                self.assertEqual(execute(job,root/'timeout')['status'],'failed')
                kill.assert_called_once()

if __name__=='__main__': unittest.main()
