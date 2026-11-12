import io,json,os,unittest
from unittest.mock import patch,MagicMock
from pan2kit.vast_preflight import preflight,NoRedirect
class VastPreflightTests(unittest.TestCase):
    def test_missing_key_never_calls_network(self):
        with patch.dict(os.environ,{},clear=True),patch('urllib.request.build_opener') as opener:
            report=preflight(); self.assertEqual(report['status'],'blocked'); self.assertFalse(report['api_called']); opener.assert_not_called()
    def test_inventory_redacts_access_fields(self):
        response=io.BytesIO(json.dumps({'instances':[{'id':1,'gpu_name':'H200','env':{'TOKEN':'hidden'},'ssh_host':'hidden','api_key':'hidden'}]}).encode())
        opener=MagicMock(); opener.open.return_value=response
        with patch.dict(os.environ,{'VAST_API_KEY':'test_only'}),patch('urllib.request.build_opener',return_value=opener):
            result=preflight()
        self.assertEqual(result['instances'],[{'id':1,'gpu_name':'H200'}])
        self.assertNotIn('hidden',json.dumps(result)); self.assertNotIn('test_only',json.dumps(result))
    def test_redirect_is_refused(self):
        self.assertIsNone(NoRedirect().redirect_request(None,None,None,None,None,None))
    def test_remote_error_does_not_echo_credentials(self):
        with patch.dict(os.environ,{'VAST_API_KEY':'test_only'}),patch('urllib.request.build_opener',side_effect=RuntimeError('test_only')):
            report=preflight()
        self.assertNotIn('test_only',json.dumps(report)); self.assertEqual(report['status'],'blocked')
if __name__=='__main__': unittest.main()
