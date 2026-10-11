"""Owner-only HTML review and confirmation; no password or approval mutation in MCP."""
import html
import json
from http.cookies import SimpleCookie, CookieError
from urllib.parse import urlencode, urlsplit
from approvals import ApprovalError
from approval_convenience import OWNER_SESSION_SECONDS

COOKIE = "__Secure-fmg-dot-approval"
# no-referrer makes navigation-mode form POSTs send Origin: null. Keep the
# exact-Origin guard while omitting the approval token from Referer headers.
REFERRER_POLICY = "strict-origin"
MESSAGES = {
    "owner_authentication_failed": "소유자 연결 비밀번호가 일치하지 않습니다.",
    "approval_password_rate_limit": "확인 요청이 많습니다. 10분 뒤 다시 시도하세요.",
    "approval_screen_expired": "승인 화면이 만료됐습니다. 닷에서 새 승인 화면을 요청하세요.",
    "approval_state_conflict": "작업 상태가 바뀌었습니다. 닷에서 작업을 다시 조회하세요. 재실행하지 않았습니다.",
    "approval_binding_changed": "커뮤니티·Gateway·모델 또는 저장소 연결이 바뀌었습니다. 새 제안을 확인하세요.",
    "connection_unavailable": "원 제안 연결이 만료됐거나 철회됐습니다. 닷의 연결을 확인하세요.",
    "community_access_required": "이 커뮤니티의 접근 권한이 철회됐습니다.",
    "owner_confirmation_required": "소유자 확인이 만료됐습니다. 비밀번호를 다시 확인하세요.",
    "approval_capacity": "승인 요청 보관 한도에 도달했습니다. 관리자에게 문의하세요.",
    "approval_request_invalid": "검토 화면의 요청이 달라졌습니다. 화면을 새로 열어 확인하세요.",
}
STYLE = """body{font-family:system-ui,sans-serif;max-width:780px;margin:32px auto;padding:0 20px;color:#202124;background:#fff}h1{font-size:24px}dt{font-weight:600;margin-top:12px}dd{margin:4px 0;overflow-wrap:anywhere}pre{white-space:pre-wrap;overflow-wrap:anywhere;border:1px solid #ccc;padding:16px;border-radius:8px;font:inherit}button,input{font:inherit;padding:12px;border:1px solid #777;border-radius:6px}button{cursor:pointer;background:#1b4e35;color:white}button:focus-visible,input:focus-visible,a:focus-visible{outline:3px solid #2860cf;outline-offset:3px}.error{color:#a51c19}small{overflow-wrap:anywhere}@media(prefers-color-scheme:dark){body{background:#1a1a1a;color:#eee}}"""


def escaped(value):
    return html.escape(str(value), quote=True)


def page(body):
    return '<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Buzz 작업 소유자 승인</title><style>'+STYLE+'</style><main><h1>Buzz 작업 소유자 승인</h1>'+body+'</main></html>'


def cookie(headers):
    try:
        parsed = SimpleCookie()
        raw = headers.get("Cookie", "")
        if len(raw) > 8000:
            return ""
        parsed.load(raw)
        return parsed[COOKIE].value if COOKIE in parsed else ""
    except CookieError:
        return ""


class ApprovalPages:
    def __init__(self, approvals):
        self.approvals = approvals
        self.path = urlsplit(approvals.oauth.issuer).path + "/approval"

    def reply(self, handler, status, body, headers=None):
        values = {"Referrer-Policy": REFERRER_POLICY, "X-Frame-Options": "DENY",
                  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"}
        values.update(headers or {})
        return handler.reply(status, page(body), values, html=True)

    def login(self, token, view="single"):
        extra = '<input type="hidden" name="view" value="batch">' if view == "batch" else ''
        return '<p>연결할 때 사용한 소유자 비밀번호를 한 번 확인하고 작업 내용을 검토하세요.</p><form method="post" action="'+escaped(self.path)+'"><input type="hidden" name="action" value="review"><input type="hidden" name="token" value="'+escaped(token)+'">'+extra+'<label for="owner-password">소유자 연결 비밀번호</label><p><input id="owner-password" type="password" name="password" maxlength="512" autocomplete="current-password" required></p><p><label><input type="checkbox" name="remember" value="1" checked> 이 브라우저에서 소유자 확인을 30분간 유지</label></p><p>같은 연결 계정·커뮤니티·Gateway에만 적용됩니다. 각 작업은 내용을 검토한 뒤 직접 승인합니다. 비밀번호는 이 화면에만 입력하고 닷 대화창에는 보내지 마세요.</p><button type="submit">소유자 확인 후 작업 검토</button></form>'

    def review(self, row, token, session, confirm=True):
        task, current = self.approvals.current(row, pending=not row["receipt"])
        proposal = json.loads(task["proposal"])
        fields = [("커뮤니티", row["community_id"]), ("작업 UUID", task["id"]),
                  ("제안 연결", row["client"]), ("역할", proposal["role_id"]),
                  ("모델", proposal["requested_model"]), ("effort", proposal["requested_effort"]),
                  ("현재 상태 / revision", str(task["status"]) + " / " + str(task["revision"])),
                  ("전체 제안 SHA-256", task["proposal_hash"]),
                  ("소유자", current["owner_pubkey"]), ("커뮤니티 주소", current["relay_origin"]),
                  ("Gateway 신원", current["gateway_agent_pubkey"])]
        project = proposal.get("project")
        if project:
            fields.extend(("저장소 " + key, value) for key, value in sorted(project.items()))
        else:
            fields.append(("저장소 실행", "이 제안에는 코드 프로젝트 연결이 포함되지 않았습니다."))
        body = '<dl>'+''.join('<dt>'+escaped(key)+'</dt><dd>'+escaped(value)+'</dd>' for key, value in fields)+'</dl><h2>작업 지시문 전체</h2><pre>'+escaped(proposal["instructions"])+'</pre>'
        if row["receipt"]:
            receipt = json.loads(row["receipt"])
            return body + '<p role="status">이 화면의 승인은 이미 기록됐습니다. 다시 실행하지 않습니다. 승인 기록은 실행 완료를 뜻하지 않습니다.</p><small>승인 receipt SHA-256: '+escaped(receipt["receipt_hash"])+'</small><p>닷으로 돌아가 이 작업의 상태와 결과를 조회하세요.</p>'
        if not confirm:
            return body
        csrf = self.approvals.csrf(token, session)
        return body + '<p>승인하면 위 제안 그대로 Hostinger 실행 대기열에 들어갑니다. 커뮤니티·역할·모델·effort와 작업 범위를 확인하세요. 자동 외부 전송은 요청하지 않습니다.</p><form method="post" action="'+escaped(self.path)+'"><input type="hidden" name="action" value="approve"><input type="hidden" name="token" value="'+escaped(token)+'"><input type="hidden" name="csrf" value="'+escaped(csrf)+'"><button type="submit">위 작업을 승인하고 실행 대기열에 넣기</button></form><p>승인하지 않으려면 이 창을 닫으세요.</p>'

    def navigation(self, token, session):
        query = urlencode({"token": token, "view": "batch"})
        return '<p><a href="'+escaped(self.path+'?'+query)+'">이 연결의 대기 작업을 한 화면에서 검토</a></p><form method="post" action="'+escaped(self.path)+'"><input type="hidden" name="action" value="logout"><input type="hidden" name="token" value="'+escaped(token)+'"><input type="hidden" name="csrf" value="'+escaped(self.approvals.csrf(token, session))+'"><button type="submit">소유자 확인 종료</button></form>'

    def batch(self, row, token, session):
        rows, unavailable = self.approvals.pending_batch(row, session)
        body = '<h2>대기 작업 함께 검토</h2><p>같은 연결 계정·커뮤니티·Gateway의 준비된 작업 '+str(len(rows))+'개입니다. 아래에 표시된 제안만 승인됩니다. 각 작업의 전체 지시문을 확인하세요.</p>'
        for candidate in rows:
            single = self.path+'?'+urlencode({"token": self.approvals.token(candidate)})
            body += '<section><h3>'+escaped(candidate["task_id"])+'</h3>'+self.review(candidate, token, session, confirm=False)+'<p><a href="'+escaped(single)+'">이 작업만 별도로 검토·승인</a></p></section><hr>'
        if unavailable:
            body += '<p role="status">만료·상태 변경 또는 한도 때문에 아래 작업은 이번 승인에 포함하지 않았습니다.</p><ul>'+''.join('<li>'+escaped(item['task_id'])+' · '+escaped(MESSAGES.get(item['reason'], '현재 승인에 포함할 수 없음'))+'</li>' for item in unavailable)+'</ul>'
        if rows:
            selection = self.approvals.selection(rows)
            csrf = self.approvals.batch_csrf(token, session, selection)
            body += '<form method="post" action="'+escaped(self.path)+'"><input type="hidden" name="action" value="approve_batch"><input type="hidden" name="token" value="'+escaped(token)+'"><input type="hidden" name="selection" value="'+escaped(selection)+'"><input type="hidden" name="csrf" value="'+escaped(csrf)+'"><button type="submit">위 '+str(len(rows))+'개 작업을 모두 승인</button></form><p>한 작업이라도 상태·연결이 바뀌면 모두 승인하지 않고 새 검토를 요청합니다.</p>'
        else:
            body += '<p role="status">현재 함께 승인할 대기 작업이 없습니다. 닷에서 작업 상태를 조회하세요.</p>'
        return body

    def get(self, handler, args):
        try:
            if set(args) not in ({"token"}, {"token", "view"}) or args.get("view", "single") not in ("single", "batch"):
                raise ApprovalError("approval_unavailable")
            token = args["token"]
            with self.approvals.store.lock:
                row = self.approvals.lookup(token)
                session = cookie(handler.headers)
                view = args.get("view", "single")
                if self.approvals.session(row, session):
                    body = (self.batch(row, token, session) if view == "batch" else self.review(row, token, session)) + self.navigation(token, session)
                else:
                    self.approvals.current(row, pending=not row["receipt"])
                    body = self.login(token, view)
            return self.reply(handler, 200, body)
        except (ValueError, KeyError, TypeError, OSError) as error:
            return self.reply(handler, 409, '<p class="error" role="alert">'+escaped(MESSAGES.get(str(error), "현재 승인 화면을 확인할 수 없습니다. 닷에서 작업을 다시 조회하세요."))+'</p>')

    def post(self, handler, args, peer):
        token = args.get("token", "")
        try:
            with self.approvals.store.lock, self.approvals.store.db:
                row = self.approvals.lookup(token)
                required = {"action", "token", "password"}
                if args.get("action") == "review" and required <= set(args) <= required | {"remember", "view"} and args.get("remember", "1") == "1" and args.get("view", "single") in ("single", "batch"):
                    remember = args.get("remember") == "1"
                    session = self.approvals.authenticate(row, args["password"], peer, remember=remember)
                    destination = {"token": token, **({"view": "batch"} if args.get("view") == "batch" else {})}
                    headers = {"Set-Cookie": COOKIE+'='+session+'; Path='+self.path+'; Max-Age='+str(OWNER_SESSION_SECONDS if remember else 300)+'; Secure; HttpOnly; SameSite=Strict',
                               "Location": self.path + "?" + urlencode(destination)}
                    return handler.reply(303, headers={**headers, "Referrer-Policy": REFERRER_POLICY})
                if args.get("action") == "approve" and set(args) == {"action", "token", "csrf"}:
                    self.approvals.approve(token, cookie(handler.headers), args["csrf"])
                    return handler.reply(303, headers={"Location": self.path + "?" + urlencode({"token": token}), "Referrer-Policy": REFERRER_POLICY})
                if args.get("action") == "approve_batch" and set(args) == {"action", "token", "selection", "csrf"}:
                    receipt = self.approvals.approve_batch(token, cookie(handler.headers), args["selection"], args["csrf"])
                    body = '<p role="status">'+str(len(receipt["receipts"]))+'개 작업의 승인이 기록됐습니다. 실행 완료는 닷에서 결과를 조회해 확인하세요.</p><ul>'+''.join('<li>'+escaped(item['task_id'])+'</li>' for item in receipt['receipts'])+'</ul><small>승인 묶음 SHA-256: '+escaped(receipt['receipt_hash'])+'</small>'
                    return self.reply(handler, 200, body + self.navigation(token, cookie(handler.headers)))
                if args.get("action") == "logout" and set(args) == {"action", "token", "csrf"}:
                    self.approvals.logout(token, cookie(handler.headers), args["csrf"])
                    return handler.reply(303, headers={"Location": self.path+'?'+urlencode({"token": token}), "Referrer-Policy": REFERRER_POLICY,
                        "Set-Cookie": COOKIE+'=; Path='+self.path+'; Max-Age=0; Secure; HttpOnly; SameSite=Strict'})
                raise ApprovalError("approval_request_invalid")
        except (ValueError, KeyError, TypeError, OSError) as error:
            body = '<p class="error" role="alert">'+escaped(MESSAGES.get(str(error), "승인을 확인하지 못했습니다. 닷에서 작업 상태를 조회하세요. 같은 요청을 조회해 승인 기록을 복구할 수 있습니다."))+'</p>'
            if reentry(token):
                body += self.login(token, "batch" if args.get("view") == "batch" else "single")
            return self.reply(handler, 409, body)


def reentry(token):
    # Only an escaped bounded token is reflected, never the password or request body.
    return isinstance(token, str) and len(token) == 64 and all(char in "0123456789abcdef" for char in token)
