import json,sys,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
from pan2kit import PAN_COMMIT
from pan2kit.__main__ import main
class CliTests(unittest.TestCase):
    def test_four_variants_and_isolation(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d); (root/'repo').mkdir()
            for name in ('base','edited'):
                p=root/name/'transformer'; p.mkdir(parents=True); (p/'model.safetensors').write_bytes(name.encode())
            (root/'prompt').write_text('fixed prompt'); calls=[]
            class Process:
                def __init__(self,command,**kw):
                    calls.append((command,kw)); Path(command[command.index('--receipt')+1]).write_text(json.dumps({'status':'completed'}))
                def wait(self,timeout): return 0
            args=['pan2kit','matrix','--repo',str(root/'repo'),'--base',str(root/'base'),'--edited',str(root/'edited'),'--prompt-file',str(root/'prompt'),'--vae',d,'--output',str(root/'results'),'--save-quant']
            with patch.object(sys,'argv',args),patch('subprocess.check_output',side_effect=[PAN_COMMIT+'\n','']),patch('subprocess.Popen',Process): main()
            self.assertEqual(len(calls),4)
            manifest=json.loads((root/'results/matrix.json').read_text())
            self.assertEqual([x['name'] for x in manifest['variants']],['base_bf16','edited_bf16','base_quant','edited_quant'])
            self.assertEqual(manifest['quality_validation'],'pending')
            self.assertTrue(all(kw['env']['HF_HUB_OFFLINE']=='1' and kw['start_new_session'] for _,kw in calls))
            self.assertEqual(sum('--export-quant' in cmd for cmd,_ in calls),2)
if __name__=='__main__': unittest.main()
