"""Human browser setup of persistent Dot control; never an MCP approval endpoint."""
import json
import uuid
from store import digest


def review(pages, row, token, session):
    from approval_pages import escaped
    control = pages.approvals.control
    current = control.current(row)
    status = control.status(row['client'], current, row['oauth_family'])
    scope = control.scope(current)
    request = str(uuid.uuid4())
    enabled = not status['enabled']
    csrf = control.csrf(token, session, enabled, status['revision'], scope, request)
    binding = json.loads(scope)
    fields = [('커뮤니티', 'FMG'), ('원 제안 계정', row['client']),
              ('소유자', current['owner_pubkey']), ('Gateway', current['gateway_agent_pubkey']),
              ('유효 기간', '직접 끄거나 연결·허용 범위가 바뀔 때까지'),
              ('실행 한도', '24시간에 50개 · 대기/실행 작업 최대 10개')]
    body = '<h2>닷 제어 모드</h2><p role="status">현재: '+('켜짐' if status['enabled'] else '꺼짐 또는 재확인 필요')+'</p>'
    body += '<p>한 번 켜면 현재 닷 계정이 아래 FMG 역할과 Buzz 저장소에 보내는 새 작업은 매번 비밀번호나 승인 화면 없이 실행 대기열에 들어갑니다. 코드 수정도 요청 범위에 포함될 수 있습니다. 기존 에이전트의 도구 권한이 적용됩니다.</p>'
    body += '<dl>'+''.join('<dt>'+escaped(k)+'</dt><dd>'+escaped(v)+'</dd>' for k,v in fields)+'</dl>'
    body += '<h3>허용 역할과 모델</h3><ul>'+''.join('<li>'+escaped(r['role_id'])+' · '+escaped(r['configured_model'])+' · effort '+escaped(', '.join(r['supported_efforts']))+'</li>' for r in binding['roles'])+'</ul>'
    body += '<h3>허용 저장소와 브랜치</h3><ul>'+''.join('<li>'+escaped(p['role_id'])+' · '+escaped(p['repository_url'])+' · '+escaped(p['branch'])+' · '+escaped(p['execution_host'])+'</li>' for p in binding['projects'])+'</ul>'
    body += '<p>각 새 작업은 그때 확인한 커밋과 요청 effort를 고정합니다. 일반 커밋 갱신은 모드를 유지합니다. 다른 계정·커뮤니티·Gateway·모델 인증 연결·저장소·브랜치 변경은 재확인이 필요합니다. 저장소 없는 일반 작업은 실행 통제 역할(fmg-live-gate)에만 허용합니다.</p>'
    body += '<p>기존 승인 대기·복구 대기 작업은 이 설정으로 승인하거나 재실행하지 않습니다. 성공한 실제 종료 결과만 비공개 문서로 저장할 수 있습니다. 외부 메시지·게시·배포는 별도 사용자 요청 범위를 따릅니다.</p>'
    values = {'action':'configure_control','token':token,'enabled':'1' if enabled else '0',
              'revision':str(status['revision']),'scope':scope,'request_id':request,'csrf':csrf}
    body += '<form method="post" action="'+escaped(pages.path)+'">'+''.join('<input type="hidden" name="'+escaped(k)+'" value="'+escaped(v)+'">' for k,v in values.items())
    body += '<button type="submit">'+('위 범위로 닷 제어 모드 켜기' if enabled else '닷 제어 모드 끄기')+'</button></form>'
    body += '<p>끄면 이 모드가 허용한 실행 전 대기 작업을 취소하고 실행 중 작업에는 취소를 요청합니다. 취소 요청은 종료 확인을 뜻하지 않습니다. 아래 소유자 확인 종료는 브라우저 로그인만 종료하며 닷 제어 모드는 유지됩니다.</p><small>허용 범위 SHA-256: '+digest(scope.encode())+'</small>'
    return body
