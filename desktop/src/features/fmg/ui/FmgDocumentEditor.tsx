import * as React from "react";
import ReactMarkdown from "react-markdown";
import { FileText } from "lucide-react";
import { Button } from "@/shared/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";
import type { ComputerScope } from "../computerRpc";
import { documentError } from "../documentRpc";
import { useDocumentEditor } from "../useDocumentEditor";

/** Result content is rendered without raw HTML, remote images or active links. */
function DocumentPreview({ markdown }: { markdown: string }) {
  const deferred = React.useDeferredValue(markdown);
  return (
    <div className="prose prose-sm max-w-none break-words dark:prose-invert">
      <ReactMarkdown
        skipHtml
        components={{
          img: ({ alt }) => <span>[이미지: {alt ?? "첨부"}]</span>,
          a: ({ children }) => <span>{children}</span>,
        }}
      >
        {deferred}
      </ReactMarkdown>
    </div>
  );
}

/** Closing waits for local persistence; community switches fence all responses. */
export function FmgDocumentLauncher({
  scope,
  taskId,
}: {
  scope: ComputerScope;
  taskId: string;
}) {
  const [open, setOpen] = React.useState(false);
  const [closeError, setCloseError] = React.useState("");
  const [closing, setClosing] = React.useState(false);
  const flush = React.useRef<(() => Promise<void>) | null>(null);
  const generation = React.useRef(0);
  React.useEffect(
    () => () => {
      generation.current++;
    },
    [],
  );
  async function changeOpen(next: boolean) {
    if (closing) return;
    if (next) {
      setCloseError("");
      setOpen(true);
      return;
    }
    const current = generation.current;
    setClosing(true);
    try {
      await flush.current?.();
      if (generation.current === current) setOpen(false);
    } catch (failure) {
      if (generation.current === current)
        setCloseError(
          `초안을 보관하지 못해 화면을 유지했습니다. ${documentError(failure)}`,
        );
    } finally {
      if (generation.current === current) setClosing(false);
    }
  }
  return (
    <>
      <Button size="sm" variant="outline" onClick={() => void changeOpen(true)}>
        <FileText />
        Markdown 초안·문서
      </Button>
      <Dialog open={open} onOpenChange={(next) => void changeOpen(next)}>
        <DialogContent
          className="max-h-[90vh] overflow-y-auto sm:max-w-5xl"
          onInteractOutside={(event) => event.preventDefault()}
        >
          <DialogHeader>
            <DialogTitle>작업 결과 문서</DialogTitle>
            <DialogDescription>
              보관된 작업 응답과 내 초안은 별개입니다. 저장한 버전은 수정되지
              않으며, 편집 내용은 새 버전으로 저장합니다.
            </DialogDescription>
          </DialogHeader>
          {closeError ? (
            <div className="space-y-2">
              <p role="alert" className="text-sm text-destructive">
                {closeError}
              </p>
              <Button
                size="sm"
                variant="destructive"
                disabled={closing}
                onClick={() => setOpen(false)}
              >
                보관되지 않은 변경사항을 버리고 닫기
              </Button>
            </div>
          ) : null}
          {closing ? (
            <p role="status" className="text-sm">
              암호화 초안을 보관한 뒤 닫습니다.
            </p>
          ) : null}
          {open ? (
            <DocumentEditor
              key={`${scope.relay}:${scope.owner}:${scope.agent}:${taskId}`}
              scope={scope}
              taskId={taskId}
              registerFlush={flush}
            />
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}

function DocumentEditor({
  scope,
  taskId,
  registerFlush,
}: {
  scope: ComputerScope;
  taskId: string;
  registerFlush: React.RefObject<(() => Promise<void>) | null>;
}) {
  const editor = useDocumentEditor(scope, taskId);
  const [preview, setPreview] = React.useState(false);
  const bytes = new TextEncoder().encode(editor.draft.markdown).length;
  React.useEffect(() => {
    registerFlush.current = () =>
      editor.ready ? editor.flush() : Promise.resolve();
    return () => {
      registerFlush.current = null;
    };
  }, [registerFlush, editor.ready, editor.flush]);
  const disabled = editor.busy || !editor.ready;
  return (
    <div className="space-y-4" aria-busy={editor.busy}>
      <p className="break-all text-xs text-muted-foreground">
        작업 ID: {taskId} · 기준 버전: {editor.draft.baseVersion || "새 문서"}
      </p>
      {editor.error ? (
        <p role="alert" className="text-sm text-destructive">
          {editor.error}
        </p>
      ) : null}
      {editor.shown?.source_validation === "needs_reconcile" ? (
        <p role="alert" className="text-sm text-destructive">
          저장 당시 원본은 보존되어 있으나 현재 작업 증거와 차이가 있습니다.
          결과 확인·복구가 필요하며 새 버전 저장을 진행하지 마세요.
        </p>
      ) : null}
      <p role="status" className="text-sm">
        {editor.busy ? "문서 처리 중" : editor.notice || editor.localStatus}
      </p>
      {editor.access && !editor.access.enabled ? (
        <p className="rounded-lg border p-3 text-sm">
          원래 작업을 제안한 GPT dot 연결에서 이 작업의 Desktop 문서 접근을
          허용해야 합니다. 작업 ID를 전달하고 문서 Desktop 접근 허용을
          요청하세요. 다른 연결에서 만든 작업에는 자동 접근하지 않습니다.
        </p>
      ) : null}
      {editor.access && !editor.access.completion_verified ? (
        <p className="text-sm">
          실제 성공 종료 증거가 없어 서버 저장을 사용할 수 없습니다.
        </p>
      ) : null}
      <label className="block space-y-2 text-sm">
        <span className="font-medium">내 Markdown 초안</span>
        <textarea
          aria-label="내 Markdown 초안"
          rows={12}
          disabled={disabled}
          className="w-full rounded-md border bg-background p-3 font-mono text-sm"
          value={editor.draft.markdown}
          onChange={(event) => editor.edit(event.target.value)}
        />
      </label>
      <p
        className={`text-xs ${bytes > 32768 ? "text-destructive" : "text-muted-foreground"}`}
      >
        {bytes.toLocaleString("ko-KR")} / 32,768 바이트 · {editor.localStatus}
      </p>
      <p className="text-xs text-muted-foreground">
        계정 변경이나 앱 종료 전 암호화 초안 보관 완료를 확인하세요. 서버 저장은
        성공 종료 확인과 Desktop 접근 허용이 필요합니다.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={disabled}
          onClick={() => void editor.refreshAccess()}
        >
          접근·성공 종료 다시 확인
        </Button>
        <Button
          size="sm"
          disabled={
            disabled ||
            !!editor.draft.pending ||
            !editor.access?.enabled ||
            !editor.access.completion_verified ||
            !editor.draft.markdown.trim() ||
            bytes > 32768
          }
          onClick={() => void editor.save()}
        >
          버전 저장
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={disabled}
          onClick={() => void editor.flush().catch(() => undefined)}
        >
          로컬 초안 보관
        </Button>
        <Button
          size="sm"
          variant="outline"
          aria-pressed={preview}
          onClick={() => setPreview((value) => !value)}
        >
          미리보기
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={
            disabled ||
            !!editor.draft.pending ||
            !editor.shown ||
            editor.draft.markdown !== editor.shown.markdown ||
            editor.draft.documentId !== editor.shown.document_id
          }
          onClick={() => void editor.clearLocal()}
        >
          확인된 로컬 보관 정리
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={disabled || !editor.access?.enabled}
          onClick={() => void editor.readSource()}
        >
          보관된 원본 조회
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={disabled || !editor.access?.enabled}
          onClick={() => void editor.compare()}
        >
          최신 버전·충돌 비교
        </Button>
      </div>
      {editor.draft.pending ? (
        <section
          aria-label="미확인 저장 요청"
          className="space-y-2 rounded-lg border p-3"
        >
          <p className="text-sm">
            저장 여부가 확인되지 않았습니다. 확인 전에는 새 요청을 만들지
            않습니다.
          </p>
          <p className="break-all font-mono text-xs">
            요청 UUID: {editor.draft.pending.saveRequestId}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={disabled}
              onClick={() => void editor.recover()}
            >
              저장 결과 확인
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={disabled}
              onClick={() => void editor.save(true)}
            >
              같은 요청으로 재시도
            </Button>
          </div>
        </section>
      ) : null}
      {preview ? (
        <section aria-label="초안 미리보기" className="rounded-lg border p-4">
          <DocumentPreview markdown={editor.draft.markdown} />
        </section>
      ) : null}
      {editor.latest ? (
        <section
          aria-label="최신 버전과 내 초안 비교"
          className="space-y-3 rounded-lg border p-3"
        >
          <h3 className="text-sm font-semibold">
            최신 저장본 v{editor.latest.version} · 내 초안은 위 편집기에
            유지됩니다
          </h3>
          <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words text-sm">
            {editor.latest.markdown}
          </pre>
          <Button
            size="sm"
            variant="outline"
            disabled={disabled || !!editor.draft.pending}
            onClick={editor.useLatestBase}
          >
            내 초안을 유지하고 최신 버전 기준으로 저장 준비
          </Button>
        </section>
      ) : null}
      <section aria-label="저장된 문서 버전" className="space-y-2">
        <h3 className="text-sm font-semibold">저장된 버전</h3>
        <div className="flex flex-wrap gap-2">
          {editor.versions.map((item) => (
            <Button
              key={item.version}
              size="sm"
              variant="outline"
              disabled={disabled}
              onClick={() => void editor.inspect(item)}
            >
              v{item.version}
            </Button>
          ))}
        </div>
        {editor.shown ? (
          <>
            <p className="text-xs">
              v{editor.shown.version} ·{" "}
              {new Date(editor.shown.saved_at * 1000).toLocaleString("ko-KR")} ·{" "}
              {editor.shown.source.requested_model} /{" "}
              {editor.shown.source.requested_effort ?? "기록 없음"}
            </p>
            <p className="text-xs">
              실제 응답 모델:{" "}
              {editor.shown.source.actual_model ?? "확인되지 않음"}
            </p>
            <p className="break-all font-mono text-xs">
              SHA-256: {editor.shown.content_sha256}
            </p>
            <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words text-sm">
              {editor.shown.markdown}
            </pre>
          </>
        ) : null}
      </section>
      {editor.source !== undefined ? (
        <section
          aria-label="보관된 작업 원본"
          className="space-y-2 rounded-lg border p-3"
        >
          <h3 className="text-sm font-semibold">
            보관된 작업 응답 · 요약본 · 읽기 전용
          </h3>
          <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words text-sm">
            {editor.source}
          </pre>
        </section>
      ) : null}
    </div>
  );
}
