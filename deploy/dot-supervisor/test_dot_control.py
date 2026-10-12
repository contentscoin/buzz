"""Persistent delegation at production browser/Tasks/claim seams, isolated SQLite only."""
import copy
import json
import sqlite3
import time
import unittest
import uuid
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import parse_qs, urlsplit
from unittest.mock import patch
from approval_pages import ApprovalPages, COOKIE
from approvals import Approvals, ApprovalError
from store import Ledger, canonical, digest
from tasks import Tasks
import test_project_proposals


class Handler:
    headers = {}
    def reply(self, status, body=None, headers=None, html=False):
        return {'status':status,'body':body,'headers':headers or {}}


class ControlTests(unittest.TestCase):
    def setUp(self):
        self.fixture = test_project_proposals.ProjectProposalTests()
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.base=self.fixture.fixture
        self.tasks,self.store,self.approvals=self.fixture.tasks,self.fixture.store,self.base.approvals
        self.control=self.approvals.control
        self.fmg=self.fixture.fmg
        self.family=self.store.db.execute('SELECT family FROM tokens WHERE client_id=?',(self.base.client,)).fetchone()[0]
        self.task=self.propose()
        self.prepare_args={'community_id':'fmg','request_id':str(uuid.uuid4()),'task_id':self.task['task_id'],
                           'proposal_hash':self.task['proposal_hash'],'revision':self.task['revision']}
        self.prepared=self.approvals.prepare(self.prepare_args,self.base.client,self.base.header,self.base.authorize)['structuredContent']
        self.token=parse_qs(urlsplit(self.prepared['approval']['control_url']).query)['token'][0]
        self.row=self.approvals.lookup(self.token)
        self.session=self.approvals.authenticate(self.row,self.base.password,'fixture-control-peer',control=True)

    def propose(self, args=None, family='current'):
        return self.tasks.call('fmg_buzz_propose_task',args or self.fixture.arguments(),self.base.client,
            authorize=self.base.authorize,authorization_family=self.family if family=='current' else family)['structuredContent']

    def configure(self, enabled=True, request=None, revision=None, scope=None):
        grant=self.control.row(self.base.client,'fmg')
        revision=revision if revision is not None else grant['revision'] if grant else 0
        scope=scope or self.control.scope(self.fmg)
        request=request or str(uuid.uuid4())
        proof=self.control.csrf(self.token,self.session,enabled,revision,scope,request)
        return self.control.configure(self.token,self.session,enabled,revision,scope,request,proof)

    def test_prepare_get_and_password_check_never_enable_or_approve(self):
        self.assertFalse(self.prepared['approval']['dot_control']['enabled'])
        h=Handler();h.headers={'Cookie':COOKIE+'='+self.session}
        response=ApprovalPages(self.approvals).get(h,{'token':self.token,'view':'control'})
        self.assertEqual(response['status'],200)
        self.assertIn('닷 제어 모드 켜기',response['body'])
        self.assertEqual(self.control.row(self.base.client,'fmg'),None)
        self.assertEqual(self.tasks.read(self.task['task_id'])['status'],'awaiting_approval')

    def test_owner_grant_then_new_task_queues_with_immutable_receipt(self):
        event=self.configure()
        args=self.fixture.arguments(effort='high')
        task=self.propose(args)
        self.assertEqual((task['status'],task['revision']),('approved',2))
        self.assertTrue(task['dot_control']['enabled'])
        self.assertIsNone(task['run_id'])
        receipt=task['dot_approval_receipt'];self.assertEqual(receipt['source'],'chatgpt_dot_owner_control_grant')
        self.assertEqual(receipt['proposal_hash'],task['proposal_hash'])
        self.assertEqual(receipt['grant_id'],event['grant_id'])
        payload=dict(receipt);self.assertEqual(payload.pop('receipt_hash'),digest(canonical(payload).encode()))
        replay=self.propose(args);self.assertEqual(replay['dot_approval_receipt'],receipt)
        self.assertEqual(self.store.db.execute('SELECT count(*) FROM dot_control_task_receipts').fetchone()[0],1)
        with self.assertRaises(sqlite3.IntegrityError),self.store.db:
            self.store.db.execute('UPDATE dot_control_task_receipts SET receipt=?',(canonical({}),))

    def test_original_pending_replay_does_not_newly_approve(self):
        self.configure()
        self.assertEqual(self.tasks.read(self.task['task_id'])['status'],'awaiting_approval')
        self.assertIsNone(self.control.receipt(self.task['task_id']))

    def test_no_family_or_other_actual_family_cannot_use_grant(self):
        self.configure()
        for family in (None,str(uuid.uuid4())):
            with self.subTest(family=family):self.assertEqual(self.propose(family=family)['status'],'awaiting_approval')

    def test_other_account_and_community_cannot_use_grant(self):
        self.configure()
        args=self.fixture.arguments();args.pop('community_id');args.pop('project_id')
        task=self.propose(args)
        self.assertEqual(task['status'],'awaiting_approval')
        self.assertFalse(task['dot_control']['enabled'])
        client=str(uuid.uuid4())
        header='Bearer '+self.base.oauth.issue(client,self.base.oauth.resource)['access_token']
        family=self.store.db.execute('SELECT family FROM tokens WHERE hash=?',(digest(header[7:].encode()),)).fetchone()[0]
        task=self.tasks.call('fmg_buzz_propose_task',self.fixture.arguments(),client,
            authorize=lambda:self.base.oauth.bearer(header),authorization_family=family)['structuredContent']
        self.assertEqual(task['status'],'awaiting_approval')

    def test_generic_coding_manual_but_generic_live_gate_delegated(self):
        self.fmg['gateway']['roles'].append(dict(self.fmg['gateway']['roles'][0],role_id='fmg-live-gate'))
        self.configure()
        args=self.fixture.arguments();args.pop('project_id')
        self.assertEqual(self.propose(args)['status'],'awaiting_approval')
        args.update(request_id=str(uuid.uuid4()),role_id='fmg-live-gate')
        self.assertEqual(self.propose(args)['status'],'approved')

    def test_new_commit_preserves_grant_and_binds_new_exact_head(self):
        self.configure()
        self.fmg['project_bindings'][0].update(source_commit='1'*40,workspace_binding='2'*64)
        task=self.propose()
        self.assertEqual(task['status'],'approved')
        self.assertEqual(task['proposal']['project']['source_commit'],'1'*40)
        self.assertEqual(task['proposal']['project']['workspace_binding'],'2'*64)

    def test_model_auth_project_branch_changes_require_reconfirmation(self):
        self.configure()
        original=copy.deepcopy(self.fmg)
        for target,key,value in [('role','model_binding','9'*64),('role','configured_model','openai/gpt-6-luna'),
                                  ('project','branch','different'),('project','repository_url','https://other.invalid/repo')]:
            with self.subTest(key=key):
                self.fmg.clear();self.fmg.update(copy.deepcopy(original))
                row=self.fmg['gateway']['roles'][0] if target=='role' else self.fmg['project_bindings'][0]
                row[key]=value
                self.assertFalse(self.control.status(self.base.client,self.fmg,self.family)['enabled'])
                if target == 'project':
                    with self.assertRaisesRegex(ValueError,'project_binding_unavailable'):self.propose()
                else:
                    self.assertEqual(self.propose()['status'],'awaiting_approval')

    def test_revoke_connection_password_epoch_and_community_block(self):
        self.configure();grant=self.control.row(self.base.client,'fmg')
        original=self.base.oauth.owner_hash
        self.base.oauth.owner_hash+='changed'
        self.assertFalse(self.control.valid(grant,self.fmg,self.family))
        with self.assertRaisesRegex(ApprovalError,'owner_confirmation_required'):self.configure(False)
        self.base.oauth.owner_hash=original
        self.fixture.allowed=False
        with self.assertRaisesRegex(ValueError,'community_access_required'):self.propose()
        self.fixture.allowed=True
        self.store.db.execute('DELETE FROM tokens WHERE client_id=?',(self.base.client,));self.store.db.commit()
        self.assertFalse(self.control.valid(grant,self.fmg,self.family))

    def test_missing_session_wrong_csrf_and_scope_cannot_activate(self):
        scope=self.control.scope(self.fmg);req=str(uuid.uuid4())
        for session,proof in [('', '0'*64),(self.session,'0'*64)]:
            with self.assertRaisesRegex(ApprovalError,'owner_confirmation_required'):
                self.control.configure(self.token,session,True,0,scope,req,proof)
        with self.assertRaisesRegex(ApprovalError,'approval_binding_changed'):self.configure(scope='{}')
        self.assertIsNone(self.control.row(self.base.client,'fmg'))

    def test_same_uuid_replay_and_concurrent_revision_conflict(self):
        request=str(uuid.uuid4());scope=self.control.scope(self.fmg)
        first=self.configure(request=request,revision=0,scope=scope)
        self.assertEqual(self.configure(request=request,revision=0,scope=scope),first)
        with self.assertRaisesRegex(ApprovalError,'request_conflict'):self.configure(False,request=request,revision=0,scope=scope)
        with self.assertRaisesRegex(ApprovalError,'approval_binding_changed'):self.configure(False,revision=0)
        def commit(_):
            try:return self.configure(False,revision=1)
            except ApprovalError:return None
        with ThreadPoolExecutor(max_workers=2) as pool:receipts=list(pool.map(commit,range(2)))
        self.assertEqual(sum(item is not None for item in receipts),1)

    def test_daily_and_queued_limits_fall_back_to_manual(self):
        self.configure()
        with patch('dot_control.QUEUE_LIMIT',1):
            self.configure(revision=1)
            first=self.propose();self.assertEqual(first['status'],'approved')
            self.assertEqual(self.propose()['status'],'awaiting_approval')
        self.configure(revision=2)
        with patch('dot_control.DAILY_LIMIT',1):
            self.configure(revision=3)
            self.assertEqual(self.propose()['status'],'awaiting_approval')

    def test_disable_cancels_only_granted_queue_and_requests_active_cancel(self):
        self.configure();one,two=self.propose(),self.propose()
        self.store.db.execute("UPDATE tasks SET status='dispatching',lease_until=? WHERE id=?",(time.time()+240,two['task_id']))
        self.store.db.execute("UPDATE tasks SET status='needs_reconcile' WHERE id=?",(self.task['task_id'],));self.store.db.commit()
        self.configure(False)
        self.assertEqual(self.tasks.read(one['task_id'])['status'],'canceled')
        self.assertEqual(self.tasks.read(two['task_id'])['status'],'cancel_requested')
        self.assertEqual(self.tasks.read(self.task['task_id'])['status'],'needs_reconcile')
        self.assertEqual(self.propose()['status'],'awaiting_approval')

    def test_dispatch_rechecks_authority_before_intent(self):
        self.configure();task=self.propose()
        self.fmg['gateway']['roles'][0]['model_binding']='4'*64
        response=self.tasks.operator({'action':'claim','arguments':{'worker_protocol':7}})
        self.assertEqual(response['reason'],'dot_control_unavailable_before_dispatch')
        task=self.tasks.read(task['task_id']);self.assertEqual(task['status'],'canceled');self.assertIsNone(task['run_id'])

    def test_dispatch_valid_delegation_uses_existing_worker(self):
        self.configure();task=self.propose()
        response=self.tasks.operator({'action':'claim','arguments':{'worker_protocol':7}})
        self.assertEqual(response['task']['task_id'],task['task_id'])
        self.assertEqual(response['task']['status'],'dispatching')
        self.assertIsNone(response['task']['run_id'])

    def test_revoked_connection_after_claim_blocks_dispatch_intent(self):
        self.configure();task=self.propose()
        claim=self.tasks.operator({'action':'claim','arguments':{'worker_protocol':7}})
        self.store.db.execute('DELETE FROM tokens WHERE client_id=?',(self.base.client,));self.store.db.commit()
        with self.assertRaisesRegex(ValueError,'dispatch_checkpoint_rejected'):
            self.tasks.operator({'action':'checkpoint','arguments':{'task_id':task['task_id'],'lease':claim['lease']}})
        self.assertIsNone(self.tasks.read(task['task_id'])['run_id'])

    def test_gateway_drift_cannot_use_standing_grant(self):
        self.configure();self.fmg['gateway_agent_pubkey']='0'*64
        self.assertFalse(self.control.status(self.base.client,self.fmg,self.family)['enabled'])
        self.assertEqual(self.propose()['status'],'awaiting_approval')

    def test_actual_mcp_handler_uses_caller_token_family_not_another_token(self):
        import importlib.util, os
        from pathlib import Path
        root=Path(self.base.directory.name)
        (root/'owner.hash').write_text(self.base.oauth.owner_hash)
        (root/'operator.token').write_text('fixture-operator-token-'*4)
        spec=importlib.util.spec_from_file_location('isolated_control_server',Path(__file__).parent/'server.py')
        server=importlib.util.module_from_spec(spec)
        with patch.dict(os.environ,{'FMG_DATA':str(root),'FMG_ISSUER':'https://fixture.invalid'}):spec.loader.exec_module(server)
        server.ledger.db.close()
        server.ledger,server.tasks,server.approvals,server.task_oauth=self.store,self.tasks,self.approvals,self.base.oauth
        self.configure()
        class Capture(server.Handler):
            def __init__(self,header):self.headers={'Authorization':header};self.response=None
            def reply(self,status,body=None,headers=None,html=False):self.response=body;return body
        other='Bearer '+self.base.oauth.issue(self.base.client,self.base.oauth.resource)['access_token']
        for header,expected in [(self.base.header,'approved'),(other,'awaiting_approval')]:
            handler=Capture(header)
            handler.mcp({'jsonrpc':'2.0','id':1,'method':'tools/call','params':{'name':'fmg_buzz_propose_task','arguments':self.fixture.arguments()}},self.base.oauth)
            self.assertEqual(handler.response['result']['structuredContent']['status'],expected)

    def test_control_can_anchor_approved_and_reconcile_task_without_reexecution(self):
        for state in ('approved','needs_reconcile','succeeded'):
            self.store.db.execute('UPDATE tasks SET status=?,revision=revision+1 WHERE id=?',(state,self.task['task_id']));self.store.db.commit()
            row=self.tasks.read(self.task['task_id']);args=dict(self.prepare_args,request_id=str(uuid.uuid4()),revision=row['revision'])
            result=self.approvals.prepare(args,self.base.client,self.base.header,self.base.authorize)['structuredContent']
            token=parse_qs(urlsplit(result['approval']['control_url']).query)['token'][0]
            self.approvals.control.current(self.approvals.lookup(token))
            self.assertEqual(self.tasks.read(row['id'])['status'],state)
        self.configure()
        self.assertEqual(self.tasks.read(self.task['task_id'])['status'],'succeeded')

    def test_browser_login_configure_redirect_and_disable_button(self):
        pages,h=ApprovalPages(self.approvals),Handler()
        response=pages.post(h,{'action':'review','token':self.token,'view':'control','password':self.base.password},'fixture-page-peer')
        self.assertEqual(response['status'],303)
        self.assertIn('view=control',response['headers']['Location'])
        session=response['headers']['Set-Cookie'].split(';')[0].split('=',1)[1]
        h.headers={'Cookie':COOKIE+'='+session}
        scope=self.control.scope(self.fmg);req=str(uuid.uuid4())
        proof=self.control.csrf(self.token,session,True,0,scope,req)
        response=pages.post(h,{'action':'configure_control','token':self.token,'enabled':'1','revision':'0','scope':scope,'request_id':req,'csrf':proof},'fixture-page-peer')
        self.assertEqual(response['status'],303)
        response=pages.get(h,{'token':self.token,'view':'control'})
        self.assertIn('닷 제어 모드 끄기',response['body'])
        self.assertNotIn(self.base.password,response['body'])

    def test_expired_screen_rejected_even_with_owner_session(self):
        with patch('dot_control.time.time',return_value=self.row['expires']+1):
            with self.assertRaisesRegex(ApprovalError,'approval_screen_expired'):self.configure()

    def test_grants_and_receipts_survive_real_database_reopen(self):
        event=self.configure();task=self.propose()
        second=Ledger(__import__('pathlib').Path(self.base.directory.name))
        try:
            tasks=Tasks(second,self.base.oauth.resource);approval=Approvals(tasks,self.base.oauth,'isolated-operator-secret-'*3)
            self.assertEqual(approval.control.row(self.base.client,'fmg')['id'],event['grant_id'])
            self.assertTrue(approval.control.valid(approval.control.row(self.base.client,'fmg'),self.fmg,self.family))
            self.assertEqual(approval.receipt(task['task_id']),task['dot_approval_receipt'])
        finally:second.db.close()

    def test_task_and_receipt_creation_roll_back_together(self):
        self.configure()
        self.store.db.execute("CREATE TRIGGER injected_control_failure BEFORE INSERT ON dot_control_task_receipts BEGIN SELECT RAISE(ABORT,'fixture-failure'); END;");self.store.db.commit()
        args=self.fixture.arguments()
        with self.assertRaises(sqlite3.IntegrityError):self.propose(args)
        self.assertIsNone(self.store.db.execute('SELECT id FROM tasks WHERE request_id=?',(args['request_id'],)).fetchone())


if __name__=='__main__':unittest.main()
