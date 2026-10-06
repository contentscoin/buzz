import * as React from "react";
import { CopyAction } from "./FmgTaskActions";

/** Command copies grant no authority; the owner sends them to their private bot. */
export function FmgOwnerDocumentAccess({
  taskId,
  proposalHash,
  revision,
  enabled,
}: {
  taskId: string;
  proposalHash: string;
  revision?: number;
  enabled: boolean;
}) {
  const [requestId] = React.useState(() => crypto.randomUUID());
  const action = enabled ? "revoke" : "allow";
  const query = `/fmg_document access ${taskId}`;
  const change =
    revision !== undefined && revision < 2147483647
      ? `/fmg_document ${action} ${taskId} ${proposalHash} ${revision} ${requestId}`
      : null;
  return (
    <section
      aria-label="Hostinger main 작업의 문서 접근 설정"
      className="space-y-3 rounded-lg border p-3"
    >
      <h4 className="text-sm font-medium">Hostinger main 문서 접근</h4>
      <p className="text-xs text-muted-foreground">
        현재 접근: {enabled ? "허용" : "차단"} · 접근 revision:{" "}
        {revision ?? "서버 확인 필요"}. 봇 개인 대화에 직접 보내고 접근·성공
        종료 다시 확인을 누르세요. 문서 접근 허용은 작업 실행 승인이 아닙니다.
      </p>
      {[
        { text: query, label: "문서 접근 조회 명령" },
        ...(change
          ? [
              {
                text: change,
                label: enabled ? "문서 접근 철회 명령" : "문서 접근 허용 명령",
              },
            ]
          : []),
      ].map((command) => (
        <div key={command.text} className="space-y-2">
          <CopyAction label={command.label} text={command.text} />
          <textarea
            aria-label={command.label}
            readOnly
            rows={3}
            value={command.text}
            className="w-full rounded-md border bg-muted p-2 font-mono text-xs"
            onFocus={(event) => event.target.select()}
          />
        </div>
      ))}
      <p className="text-xs text-muted-foreground">
        응답 유실이면 같은 UUID의 명령을 다시 보내세요. 충돌이면 접근을 다시
        조회한 뒤 새 명령을 사용하세요. 철회는 기존 서버 문서나 이미 보관한 로컬
        초안을 삭제하지 않습니다.
      </p>
    </section>
  );
}
