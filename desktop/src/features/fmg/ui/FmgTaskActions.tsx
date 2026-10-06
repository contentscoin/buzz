import * as React from "react";
import { Copy } from "lucide-react";
import { Button } from "@/shared/ui/button";
import { writeTextToClipboard } from "@/shared/lib/clipboard";
import type { TaskDetail } from "../taskRpc";
import { taskMobileSummary, taskOwnerCommands } from "../taskPresentation";

function CopyAction({ text, label }: { text: string; label: string }) {
  const [busy, setBusy] = React.useState(false);
  const [feedback, setFeedback] = React.useState("");
  const [error, setError] = React.useState("");
  const active = React.useRef(false);
  const pending = React.useRef(false);
  React.useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  async function copy() {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setFeedback("");
    setError("");
    try {
      await writeTextToClipboard(text);
      if (active.current)
        setFeedback("복사했습니다. 원하는 대화에 직접 붙여넣으세요.");
    } catch {
      if (active.current)
        setError("복사하지 못했습니다. 아래 내용을 직접 선택해 복사하세요.");
    } finally {
      pending.current = false;
      if (active.current) setBusy(false);
    }
  }
  return (
    <div className="space-y-2">
      <Button
        size="sm"
        variant="outline"
        disabled={busy}
        onClick={() => void copy()}
      >
        <Copy />
        {label} 복사
      </Button>
      {feedback ? (
        <p role="status" className="text-xs text-muted-foreground">
          {feedback}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** Private review and copy affordances; this component never sends messages. */
export function FmgTaskActions({
  detail,
  relay,
  checkedAt,
}: {
  detail: TaskDetail;
  relay: string;
  checkedAt: string;
}) {
  const commands = taskOwnerCommands(detail);
  const summary = taskMobileSummary(detail, relay, checkedAt);
  return (
    <div className="space-y-4">
      {commands.length ? (
        <section
          aria-label="소유자 Telegram 명령"
          className="space-y-3 rounded-md border p-3"
        >
          <h4 className="text-sm font-medium">소유자 Telegram에서 처리</h4>
          <p className="text-xs text-muted-foreground">
            지시문·모델·effort·저장소와 전체 해시를 검토한 뒤 봇 개인 대화에
            직접 보내세요. 실행 중 취소는 요청이며 종료를 보장하지 않습니다.
            결과가 미확정이면 재실행 전에 복구하세요.
          </p>
          {commands.map((command) => (
            <div key={command.label} className="space-y-2">
              <CopyAction
                key={command.text}
                label={command.label}
                text={command.text}
              />
              <textarea
                aria-label={command.label}
                readOnly
                value={command.text}
                rows={3}
                className="w-full rounded-md border bg-muted p-2 font-mono text-xs"
                onFocus={(event) => event.target.select()}
              />
            </div>
          ))}
          <p className="break-all text-xs text-muted-foreground">
            전체 제안 해시: {detail.proposal_hash}
          </p>
        </section>
      ) : null}
      <details className="rounded-md border p-3">
        <summary className="cursor-pointer text-sm font-medium">
          모바일용 작업 요약
        </summary>
        <div className="space-y-3 pt-3">
          <p className="text-xs text-muted-foreground">
            미리보기 내용을 확인하고 복사하세요. 응답은 최대 500자이며, 불변
            결과 문서 저장과 별개입니다.
          </p>
          <textarea
            aria-label="모바일용 작업 조회 요약"
            readOnly
            value={summary}
            rows={10}
            className="w-full rounded-md border bg-muted p-2 text-xs"
            onFocus={(event) => event.target.select()}
          />
          <CopyAction key={summary} label="작업 요약" text={summary} />
        </div>
      </details>
    </div>
  );
}
