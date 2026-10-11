"""Exercise real browser/session/group commit seams using isolated fixtures only."""
import copy
from concurrent.futures import ThreadPoolExecutor
import json
import sqlite3
import time
import unittest
import uuid
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit
from approval_pages import ApprovalPages, COOKIE
from approvals import Approvals, ApprovalError
from store import digest
from store import Ledger
from pathlib import Path
import test_approvals


class ConvenienceTests(unittest.TestCase):
    setUp = test_approvals.ApprovalTests.setUp
    current = test_approvals.ApprovalTests.current
    authorize = test_approvals.ApprovalTests.authorize
    prepare = test_approvals.ApprovalTests.prepare
    count = test_approvals.ApprovalTests.count
    def another(self):
        task = self.tasks.call('fmg_buzz_propose_task', {'request_id':str(uuid.uuid4()),
            'role_id':'fmg-backend','instructions':'두 번째 격리 읽기 작업'}, self.client,
            authorize=self.authorize)['structuredContent']
        result = self.prepare({'task_id':task['task_id'], 'request_id':str(uuid.uuid4()),
            'proposal_hash':task['proposal_hash'],'revision':1})
        token = parse_qs(urlsplit(result['approval']['url']).query)['token'][0]
        return self.approvals.lookup(token), token

    def group(self, remember=True):
        first = self.prepare()
        token = parse_qs(urlsplit(first['approval']['url']).query)['token'][0]
        anchor = self.approvals.lookup(token)
        second, _ = self.another()
        session = self.approvals.authenticate(anchor,self.password,'fixture-peer',remember=remember)
        rows, _ = self.approvals.pending_batch(anchor,session)
        selection = self.approvals.selection(rows)
        return anchor,second,token,session,selection,self.approvals.batch_csrf(token,session,selection)

    def test_remembered_session_reuses_password_check_without_approval(self):
        anchor,second,token,session,_,_=self.group()
        self.assertTrue(self.approvals.session(anchor,session))
        self.assertTrue(self.approvals.session(second,session))
        self.assertEqual(self.count('dot_owner_sessions'),1)
        self.assertEqual(self.count('dot_approval_sessions'),0)
        self.assertEqual(self.tasks.read(second['task_id'])['status'],'awaiting_approval')
        stored=self.store.db.execute('SELECT * FROM dot_owner_sessions').fetchone()
        self.assertEqual(stored['hash'],digest(session.encode()))
        self.assertNotIn(session,dict(stored).values())
        self.assertLessEqual(stored['expires']-time.time(),1800)

    def test_scoped_session_does_not_cross_account_family_community_or_gateway(self):
        anchor,_,_,session,_,_=self.group()
        for key,value in [('client',str(uuid.uuid4())),('oauth_family','other-family'),
                          ('community_id','fmg'),('audience','different-gateway')]:
            changed=dict(anchor);changed[key]=value
            with self.subTest(key=key): self.assertFalse(self.approvals.session(changed,session))

    def test_password_change_expiry_and_logout_invalidate_remembered_session(self):
        anchor,_,token,session,_,_=self.group()
        old=self.oauth.owner_hash;self.oauth.owner_hash='changed'
        self.assertFalse(self.approvals.session(anchor,session));self.oauth.owner_hash=old
        with patch('approval_convenience.time.time',return_value=time.time()+1801):
            self.assertFalse(self.approvals.session(anchor,session))
        self.approvals.logout(token,session,self.approvals.csrf(token,session))
        self.assertFalse(self.approvals.session(anchor,session))
        self.assertEqual(self.count('dot_owner_sessions'),0)

    def test_group_approves_once_and_replays_original_receipts(self):
        anchor,second,token,session,selection,csrf=self.group()
        first=self.approvals.approve_batch(token,session,selection,csrf)
        self.assertEqual(first,self.approvals.approve_batch(token,session,selection,csrf))
        self.assertEqual(self.count('dot_approval_batches'),1)
        for row in [anchor,second]:
            self.assertEqual(self.tasks.read(row['task_id'])['revision'],2)
            self.assertEqual(self.tasks.read(row['task_id'])['status'],'approved')

    def test_group_works_without_remember_checkbox_and_only_anchor_is_reusable(self):
        anchor,second,token,session,selection,csrf=self.group(remember=False)
        self.assertFalse(self.approvals.session(second,session))
        self.assertEqual(len(self.approvals.approve_batch(token,session,selection,csrf)['receipts']),2)

    def test_group_request_cannot_add_new_task_after_review(self):
        anchor,_,token,session,selection,csrf=self.group()
        third,_=self.another()
        receipt=self.approvals.approve_batch(token,session,selection,csrf)
        self.assertEqual(len(receipt['receipts']),2)
        self.assertEqual(self.tasks.read(third['task_id'])['status'],'awaiting_approval')

    def test_group_selection_tamper_and_wrong_csrf_do_not_approve(self):
        _,_,token,session,selection,csrf=self.group()
        for body,proof in [(selection[:-1]+',[]]',csrf),(selection,'0'*64)]:
            with self.assertRaisesRegex(ApprovalError,'owner_confirmation_required'):
                self.approvals.approve_batch(token,session,body,proof)
        self.assertEqual(self.count('dot_approval_batches'),0)

    def test_group_task_conflict_rolls_back_all(self):
        anchor,second,token,session,selection,csrf=self.group()
        self.tasks.operator({'action':'cancel','arguments':{'task_id':second['task_id'],'proposal_hash':second['proposal_hash']}})
        with self.assertRaisesRegex(ApprovalError,'approval_state_conflict'):
            self.approvals.approve_batch(token,session,selection,csrf)
        self.assertEqual(self.tasks.read(anchor['task_id'])['status'],'awaiting_approval')
        self.assertEqual(self.count('dot_approval_batches'),0)

    def test_group_storage_error_rolls_back_previously_updated_task(self):
        anchor,second,token,session,selection,csrf=self.group()
        self.store.db.executescript("CREATE TRIGGER fixture_fail_batch BEFORE INSERT ON dot_approval_batches BEGIN SELECT RAISE(ABORT,'fixture_batch_disk_failure'); END;")
        with self.assertRaisesRegex(sqlite3.IntegrityError,'fixture_batch_disk_failure'):
            self.approvals.approve_batch(token,session,selection,csrf)
        for row in [anchor,second]:
            self.assertEqual(self.tasks.read(row['task_id'])['status'],'awaiting_approval')
            self.assertIsNone(self.approvals.lookup(self.approvals.token(row))['receipt'])

    def test_group_snapshot_change_at_commit_denies_all(self):
        _,_,token,session,selection,csrf=self.group()
        original,changed=copy.deepcopy(self.snapshot),copy.deepcopy(self.snapshot)
        changed['generation']=str(uuid.uuid4())
        with patch.object(self.tasks.communities,'current',side_effect=[original,original,changed]):
            with self.assertRaisesRegex(ApprovalError,'approval_binding_changed'):
                self.approvals.approve_batch(token,session,selection,csrf)
        self.assertEqual(self.count('dot_approval_batches'),0)

    def test_group_revoked_oauth_or_community_denies_all(self):
        _,_,token,session,selection,csrf=self.group()
        self.allowed=False
        with self.assertRaisesRegex(ValueError,'community_access_required'):
            self.approvals.approve_batch(token,session,selection,csrf)
        self.allowed=True
        self.store.db.execute('DELETE FROM tokens');self.store.db.commit()
        with self.assertRaisesRegex(ApprovalError,'connection_unavailable'):
            self.approvals.approve_batch(token,session,selection,csrf)

    def test_group_concurrent_posts_and_restart_commit_once(self):
        _,_,token,session,selection,csrf=self.group()
        with ThreadPoolExecutor(max_workers=2) as pool:
            receipts=list(pool.map(lambda _:self.approvals.approve_batch(token,session,selection,csrf),range(2)))
        self.assertEqual(receipts[0],receipts[1])
        replacement=Approvals(self.tasks,self.oauth,'isolated-operator-secret-'*3)
        self.assertEqual(replacement.approve_batch(token,session,selection,csrf),receipts[0])

    def test_group_filters_duplicate_screens_for_same_task(self):
        anchor,_,_,session,_,_=self.group()
        self.prepare(dict(self.args,request_id=str(uuid.uuid4())))
        rows,unavailable=self.approvals.pending_batch(anchor,session)
        self.assertEqual(len(rows),2);self.assertEqual(unavailable,[])

    def test_group_html_contains_full_escaped_proposals_and_logout(self):
        anchor,second,token,session,selection,csrf=self.group()
        pages=ApprovalPages(self.approvals)
        body=pages.batch(anchor,token,session)
        self.assertIn('&lt;script&gt;',body);self.assertNotIn('<script>',body)
        for row in [anchor,second]: self.assertIn(row['proposal_hash'],body)
        self.assertIn('위 2개 작업을 모두 승인',body)
        self.assertIn('action" value="logout',pages.navigation(token,session))

    def test_browser_cookie_keep_login_and_group_post_production_seam(self):
        class Handler:
            headers={}
            def reply(self,status,body=None,headers=None,html=False):
                return {'status':status,'body':body,'headers':headers or {}}
        anchor,_,token,_,_,_=self.group()
        pages,handler=ApprovalPages(self.approvals),Handler()
        login=pages.post(handler,{'action':'review','token':token,'password':self.password,'remember':'1','view':'batch'},'new-fixture-peer')
        self.assertEqual(login['status'],303)
        self.assertIn('Max-Age=1800; Secure; HttpOnly; SameSite=Strict',login['headers']['Set-Cookie'])
        handler.headers={'Cookie':login['headers']['Set-Cookie'].split(';')[0]}
        session=handler.headers['Cookie'].split('=',1)[1]
        rows,_=self.approvals.pending_batch(anchor,session)
        selection=self.approvals.selection(rows)
        response=pages.post(handler,{'action':'approve_batch','token':token,'selection':selection,'csrf':self.approvals.batch_csrf(token,session,selection)},'new-fixture-peer')
        self.assertEqual(response['status'],200)
        self.assertIn('2개 작업의 승인이 기록',response['body'])
        logout=pages.post(handler,{'action':'logout','token':token,'csrf':self.approvals.csrf(token,session)},'new-fixture-peer')
        self.assertIn('Max-Age=0;',logout['headers']['Set-Cookie'])

    def test_group_expired_screen_and_changed_model_deny_all(self):
        anchor,second,token,session,selection,csrf=self.group()
        with patch('approvals.time.time',return_value=time.time()+601):
            with self.assertRaisesRegex(ApprovalError,'approval_screen_expired'):
                self.approvals.approve_batch(token,session,selection,csrf)
        self.snapshot['gateway']['roles'][0]['model_binding']='e'*64
        with self.assertRaisesRegex(ApprovalError,'approval_binding_changed'):
            self.approvals.approve_batch(token,session,selection,csrf)
        for row in [anchor,second]: self.assertEqual(self.tasks.read(row['task_id'])['revision'],1)

    def test_valid_mac_cannot_cross_scope_or_repeat_task(self):
        anchor,second,token,session,selection,_=self.group()
        for changed in [json.loads(selection)+[json.loads(selection)[0]],
                        [[str(uuid.uuid4()),second['task_id'],1,second['proposal_hash']]]]:
            payload=json.dumps(changed,separators=(',',':'))
            with self.assertRaisesRegex(ApprovalError,'approval_binding_changed'):
                self.approvals.approve_batch(token,session,payload,self.approvals.batch_csrf(token,session,payload))
        changed=dict(anchor);changed['id']=str(uuid.uuid4());changed['client']=str(uuid.uuid4())
        columns=list(changed)
        self.store.db.execute('INSERT INTO dot_task_approvals('+','.join(columns)+') VALUES('+','.join('?' for _ in columns)+')',
            [changed[k] if k!='token_hash' else 'e'*64 for k in columns])
        self.store.db.commit()
        payload=self.approvals.selection([changed])
        with self.assertRaisesRegex(ApprovalError,'approval_binding_changed'):
            self.approvals.approve_batch(token,session,payload,self.approvals.batch_csrf(token,session,payload))

    def test_batch_limit_and_new_session_retention_are_bounded(self):
        anchor,_,_,session,_,_=self.group()
        for _ in range(10): self.another()
        rows,unavailable=self.approvals.pending_batch(anchor,session)
        self.assertEqual(len(rows),10);self.assertEqual(len(unavailable),2)
        payload=self.approvals.selection(rows+[anchor])
        with self.assertRaisesRegex(ApprovalError,'approval_request_invalid'):
            self.approvals.approve_batch(self.approvals.token(anchor),session,payload,
                self.approvals.batch_csrf(self.approvals.token(anchor),session,payload))
        self.store.db.execute('UPDATE dot_owner_sessions SET expires=?',(time.time()-1,));self.store.db.commit()
        self.approvals.authenticate(anchor,self.password,'other-fixture-peer',remember=True)
        self.assertEqual(self.count('dot_owner_sessions'),1)

    def test_remembered_login_and_batch_receipt_survive_real_database_reopen(self):
        anchor,_,token,session,selection,csrf=self.group()
        receipt=self.approvals.approve_batch(token,session,selection,csrf)
        old_oauth=self.oauth
        self.store.db.close();self.store=Ledger(Path(self.directory.name))
        self.tasks=test_approvals.Tasks(self.store,old_oauth.resource)
        self.oauth=test_approvals.FixtureOAuth(self.store,old_oauth.issuer,old_oauth.owner_hash)
        patch.object(self.tasks.communities,'current',side_effect=self.current).start()
        self.approvals=Approvals(self.tasks,self.oauth,'isolated-operator-secret-'*3)
        self.assertTrue(self.approvals.session(self.approvals.lookup(token),session))
        self.assertEqual(self.approvals.approve_batch(token,session,selection,csrf),receipt)

    def test_cookie_get_reuses_session_for_other_screen_without_mutation(self):
        class Handler:
            def reply(self,status,body=None,headers=None,html=False): return {'status':status,'body':body}
        _,second,_,session,_,_=self.group()
        handler=Handler();handler.headers={'Cookie':COOKIE+'='+session}
        response=ApprovalPages(self.approvals).get(handler,{'token':self.approvals.token(second)})
        self.assertEqual(response['status'],200)
        self.assertNotIn('name="password"',response['body'])
        self.assertIn(second['proposal_hash'],response['body'])
        self.assertEqual(self.tasks.read(second['task_id'])['status'],'awaiting_approval')


if __name__=='__main__': unittest.main()
