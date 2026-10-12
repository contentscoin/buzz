"""Owner-enabled persistent control for one original OAuth family and FMG audience."""
import json
import secrets
import time
import uuid
from communities import binding
from store import canonical, digest
from tasks import ROLES

DAILY_LIMIT = 50
QUEUE_LIMIT = 10


class DotControl:
    def __init__(self, approvals):
        self.approvals, self.store = approvals, approvals.store
        self.store.db.executescript("""
        CREATE TABLE IF NOT EXISTS dot_control_grants (
          id TEXT PRIMARY KEY, client TEXT NOT NULL, community_id TEXT NOT NULL,
          oauth_family TEXT NOT NULL, audience TEXT NOT NULL, scope TEXT NOT NULL,
          password_epoch TEXT NOT NULL, enabled INTEGER NOT NULL, revision INTEGER NOT NULL,
          created REAL NOT NULL, updated REAL NOT NULL, UNIQUE(client,community_id));
        CREATE TABLE IF NOT EXISTS dot_control_events (
          client TEXT NOT NULL, request_id TEXT NOT NULL, input_hash TEXT NOT NULL,
          receipt TEXT NOT NULL, PRIMARY KEY(client,request_id));
        CREATE TABLE IF NOT EXISTS dot_control_task_receipts (
          task_id TEXT PRIMARY KEY, grant_id TEXT NOT NULL, created REAL NOT NULL, receipt TEXT NOT NULL);
        CREATE TRIGGER IF NOT EXISTS dot_control_events_no_update BEFORE UPDATE ON dot_control_events
          BEGIN SELECT RAISE(ABORT,'immutable_control_event'); END;
        CREATE TRIGGER IF NOT EXISTS dot_control_events_no_delete BEFORE DELETE ON dot_control_events
          BEGIN SELECT RAISE(ABORT,'immutable_control_event'); END;
        CREATE TRIGGER IF NOT EXISTS dot_control_receipts_no_update BEFORE UPDATE ON dot_control_task_receipts
          BEGIN SELECT RAISE(ABORT,'immutable_control_receipt'); END;
        CREATE TRIGGER IF NOT EXISTS dot_control_receipts_no_delete BEFORE DELETE ON dot_control_task_receipts
          BEGIN SELECT RAISE(ABORT,'immutable_control_receipt'); END;
        """)
        approvals.tasks.dot_control = self

    def scope(self, current):
        roles = [{key: role.get(key) for key in ('role_id','configured_model','model_binding','supported_efforts')}
                 for role in current['gateway']['roles'] if role['role_id'] in ROLES]
        # Each new proposal still binds its exact fresh HEAD/workspace fingerprint.
        # The owner's persistent repository delegation must survive normal commits.
        projects = [{key: project.get(key) for key in ('project_id','repository_url','role_id','branch','execution_host')}
                    for project in current.get('project_bindings',[]) if project.get('project_id') == 'buzz']
        return canonical({'schema':1,'roles':sorted(roles,key=lambda r:r['role_id']),
                          'projects':sorted(projects,key=lambda p:p['role_id']),
                          'daily_limit':DAILY_LIMIT,'queued_limit':QUEUE_LIMIT})

    def row(self, client, community):
        return self.store.db.execute('SELECT * FROM dot_control_grants WHERE client=? AND community_id=?',
                                     (client,community)).fetchone()

    def valid(self, grant, current, family=None):
        if not grant or not grant['enabled'] or current.get('community_id') != 'fmg':
            return False
        if family is not None and grant['oauth_family'] != family:
            return False
        if grant['audience'] != canonical(binding(current)) or grant['scope'] != self.scope(current):
            return False
        if not secrets.compare_digest(grant['password_epoch'],digest(self.approvals.oauth.owner_hash.encode())):
            return False
        live = self.store.db.execute("SELECT 1 FROM tokens WHERE client_id=? AND family=? AND scope=? AND resource=? AND kind IN ('access','refresh') AND expires>? LIMIT 1",
                                    (grant['client'],grant['oauth_family'],self.approvals.oauth.scope,
                                     self.approvals.oauth.resource,time.time())).fetchone()
        return bool(live)

    def status(self, client, current, family=None):
        grant = self.row(client,current.get('community_id'))
        return {'enabled':self.valid(grant,current,family),
                'configured':bool(grant and grant['enabled']),
                'revision':grant['revision'] if grant else 0,
                'grant_id':grant['id'] if grant else None,
                'lifetime':'until_owner_disables_or_connection_or_binding_changes',
                'daily_task_limit':DAILY_LIMIT,'queued_task_limit':QUEUE_LIMIT,
                'human_confirmation_per_task_required':not self.valid(grant,current,family)}

    def current(self, row):
        if row['expires'] <= time.time():
            raise self.approvals.error('approval_screen_expired')
        _, current = self.approvals.current(row,pending=False)
        if row['community_id'] != 'fmg':
            raise self.approvals.error('dot_control_fmg_only')
        return current

    def csrf(self, token, session, enabled, revision, scope, request):
        import hashlib, hmac
        return hmac.new(self.approvals.secret,canonical(['dot-control-v1',token,session,enabled,revision,scope,request]).encode(),hashlib.sha256).hexdigest()

    def configure(self, token, session, enabled, revision, scope, request, csrf):
        with self.store.lock,self.store.db:
            row=self.approvals.lookup(token)
            if not self.approvals.remembered(row,session) or type(enabled) is not bool or type(revision) is not int:
                raise self.approvals.error('owner_confirmation_required')
            if not isinstance(request,str) or str(uuid.UUID(request)) != request:
                raise self.approvals.error('approval_request_invalid')
            if not isinstance(csrf,str) or not secrets.compare_digest(csrf,self.csrf(token,session,enabled,revision,scope,request)):
                raise self.approvals.error('owner_confirmation_required')
            current=self.current(row)
            encoded=canonical([enabled,revision,scope,row['oauth_family'],row['audience']])
            old=self.store.db.execute('SELECT * FROM dot_control_events WHERE client=? AND request_id=?',(row['client'],request)).fetchone()
            if old:
                if old['input_hash'] != digest(encoded.encode()):
                    raise self.approvals.error('request_conflict')
                return json.loads(old['receipt'])
            grant=self.row(row['client'],row['community_id'])
            if revision != (grant['revision'] if grant else 0) or scope != self.scope(current):
                raise self.approvals.error('approval_binding_changed')
            if self.store.db.execute('SELECT count(*) FROM dot_control_events').fetchone()[0] >= 10000:
                raise self.approvals.error('approval_capacity')
            identifier=grant['id'] if grant else str(uuid.uuid4()); now=time.time()
            self.store.db.execute('INSERT INTO dot_control_grants VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(client,community_id) DO UPDATE SET oauth_family=excluded.oauth_family,audience=excluded.audience,scope=excluded.scope,password_epoch=excluded.password_epoch,enabled=excluded.enabled,revision=excluded.revision,updated=excluded.updated',
                (identifier,row['client'],row['community_id'],row['oauth_family'],row['audience'],scope,
                 digest(self.approvals.oauth.owner_hash.encode()),int(enabled),revision+1,now,now))
            if not enabled:
                self.store.db.execute("UPDATE tasks SET status=CASE WHEN status='approved' THEN 'canceled' ELSE 'cancel_requested' END,revision=revision+1,updated=? WHERE client=? AND id IN (SELECT task_id FROM dot_control_task_receipts WHERE grant_id=?) AND status IN ('approved','dispatching')",(now,row['client'],identifier))
            receipt={'schema':1,'source':'chatgpt_dot_owner_control_browser','grant_id':identifier,
                     'client_id':row['client'],'community_id':row['community_id'],'enabled':enabled,
                     'revision':revision+1,'request_id':request,'recorded_at':now,'scope_hash':digest(scope.encode())}
            receipt['receipt_hash']=digest(canonical(receipt).encode())
            self.store.db.execute('INSERT INTO dot_control_events VALUES(?,?,?,?)',(row['client'],request,digest(encoded.encode()),canonical(receipt)))
            final=self.approvals.tasks.communities.current(row['client'],row['community_id'])
            if final['generation'] != current['generation'] or binding(final) != binding(current):
                raise self.approvals.error('approval_binding_changed')
            return receipt

    def receipt(self, task):
        row=self.store.db.execute('SELECT receipt FROM dot_control_task_receipts WHERE task_id=?',(task,)).fetchone()
        return json.loads(row['receipt']) if row else None

    def auto_approve(self, task, current, family):
        if not family:
            return
        grant=self.row(task['client'],current.get('community_id'))
        proposal=json.loads(task['proposal'])
        if not self.valid(grant,current,family):
            return
        project=proposal.get('project')
        if proposal['role_id'] not in ROLES or (proposal['role_id'] != 'fmg-live-gate' and
            (proposal.get('schema') != 4 or project not in current.get('project_bindings',[]) or project.get('project_id') != 'buzz')):
            return
        now=time.time()
        if self.store.db.execute('SELECT count(*) FROM dot_control_task_receipts WHERE grant_id=? AND created>?',(grant['id'],now-86400)).fetchone()[0] >= DAILY_LIMIT:
            return
        if self.store.db.execute("SELECT count(*) FROM tasks WHERE client=? AND status IN ('approved','dispatching','cancel_requested')",(task['client'],)).fetchone()[0] >= QUEUE_LIMIT:
            return
        receipt={'schema':1,'source':'chatgpt_dot_owner_control_grant','grant_id':grant['id'],
                 'grant_revision':grant['revision'],'scope_hash':digest(grant['scope'].encode()),
                 'task_id':task['id'],'proposal_hash':task['proposal_hash'],'previous_revision':task['revision'],
                 'approved_revision':task['revision']+1,'client_id':task['client'],
                 'community_id':grant['community_id'],'audience':binding(current),'approved_at':now,'status':'approved'}
        receipt['receipt_hash']=digest(canonical(receipt).encode())
        updated = self.store.db.execute("UPDATE tasks SET status='approved',revision=revision+1,updated=? WHERE id=? AND status='awaiting_approval' AND revision=?",(now,task['id'],task['revision']))
        if updated.rowcount != 1:
            raise self.approvals.error('approval_state_conflict')
        self.store.db.execute('INSERT INTO dot_control_task_receipts VALUES(?,?,?,?)',(task['id'],grant['id'],now,canonical(receipt)))

    def admission(self, task):
        receipt=self.receipt(task['id'])
        if not receipt:
            return True
        grant=self.row(task['client'],receipt['community_id'])
        try:
            current=self.approvals.tasks.communities.current(task['client'],receipt['community_id'])
            return self.valid(grant,current) and receipt['grant_revision'] == grant['revision'] and receipt['scope_hash'] == digest(grant['scope'].encode())
        except (ValueError,KeyError,TypeError,OSError):
            return False
