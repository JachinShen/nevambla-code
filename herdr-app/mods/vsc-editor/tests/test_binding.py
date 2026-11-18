import copy
import importlib.util
from pathlib import Path
import unittest

spec=importlib.util.spec_from_file_location('bind_panes',Path(__file__).resolve().parents[1]/'bind-panes.py')
bridge=importlib.util.module_from_spec(spec);spec.loader.exec_module(bridge)


def document():
    return {'spaces':[{'id':'space','tabs':[{'id':'tab','root':{'id':'root','children':[
        {'id':'p1','content':{'mod':'vsc-editor','props':{'file':{'path':'/a.png','on':'chip'}}}},
        {'id':'p2','content':{'terminal':'t1'}}]}}]}]}


class Binding(unittest.TestCase):
    def test_only_metadata_changes_and_repeated_binding_is_idempotent(self):
        original=document();saved=copy.deepcopy(original)
        changed,count=bridge.patch_document(original)
        self.assertEqual(count,1);self.assertEqual(original,saved)
        expected=copy.deepcopy(original);expected['spaces'][0]['tabs'][0]['root']['children'][0]['content']['props']['preview_pane']='p1'
        self.assertEqual(changed,expected)
        self.assertEqual(bridge.patch_document(changed),(changed,0))

    def test_every_split_copy_uses_its_own_actual_pane_id(self):
        value=document();node=value['spaces'][0]['tabs'][0]['root']['children'][0]
        clone=copy.deepcopy(node);clone['id']='p3';clone['content']['props']['preview_pane']='p1'
        value['spaces'][0]['tabs'][0]['root']['children'].append(clone)
        result,count=bridge.patch_document(value)
        self.assertEqual(count,2)
        self.assertEqual(result['spaces'][0]['tabs'][0]['root']['children'][2]['content']['props']['preview_pane'],'p3')

    def test_compare_and_swap_reloads_concurrent_changes_and_keeps_them(self):
        calls=[];value=document();version=2
        def rpc(method,params):
            nonlocal value,version
            calls.append((method,params))
            self.assertEqual(params['on'],'chip')
            if method=='doc.get':return {'result':{'value':copy.deepcopy(value),'version':version}}
            if params['version']==2:
                value['spaces'][0]['name']='new name';version=3
                return {'error':{'data':{'kind':'conflict'}}}
            self.assertEqual(params['version'],3);self.assertEqual(params['value']['spaces'][0]['name'],'new name')
            return {'result':{'version':4}}
        self.assertEqual(bridge.bind('chip',rpc),{'bound':1})
        self.assertEqual([name for name,_ in calls],['doc.get','doc.set','doc.get','doc.set'])

    def test_schema_errors_never_write_or_replace_layout(self):
        for value in [None,{'spaces':'broken'},{'spaces':[{'tabs':[{'root':{'id':'root','children':None}}]}]}]:
            calls=[]
            def rpc(method,params):
                calls.append(method);return {'result':{'value':value,'version':1}}
            with self.assertRaises(ValueError):bridge.bind(None,rpc)
            self.assertEqual(calls,['doc.get'])

    def test_read_and_write_failures_surface_the_core_error(self):
        with self.assertRaisesRegex(RuntimeError,'unavailable'):
            bridge.bind('chip',lambda *args:{'error':{'data':{'kind':'unavailable'}}})
        def rpc(method,params):
            if method=='doc.get':return {'result':{'value':document(),'version':1}}
            return {'error':{'data':{'kind':'permission_denied'}}}
        with self.assertRaisesRegex(RuntimeError,'permission_denied'):bridge.bind(None,rpc)

    def test_invalid_receipts_and_exhausted_conflicts_are_explicit(self):
        with self.assertRaisesRegex(ValueError,'version'):
            bridge.bind(None,lambda *args:{'result':{'value':document()}})
        def rpc(method,params):
            if method=='doc.get':return {'result':{'value':document(),'version':1}}
            return {'error':{'data':{'kind':'conflict'}}}
        with self.assertRaisesRegex(RuntimeError,'kept changing'):bridge.bind(None,rpc)


if __name__=='__main__':unittest.main()
