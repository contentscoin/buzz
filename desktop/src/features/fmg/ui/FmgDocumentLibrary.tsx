import * as React from "react";
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
import {
  documentLibrary,
  documentError,
  type DocumentMeta,
} from "../documentRpc";
import { FmgDocumentLauncher } from "./FmgDocumentEditor";

/** Saved documents remain discoverable outside the 25-item recent task window. */
export function FmgDocumentLibrary({ scope }: { scope: ComputerScope }) {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        <FileText />
        저장된 결과 문서
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>저장된 결과 문서</DialogTitle>
            <DialogDescription>
              현재 소유자·커뮤니티·Gateway에 속하며 원 제안 연결에서 Desktop
              접근을 허용한 문서만 조회합니다. 최근 작업 25건과 별개로
              보관됩니다.
            </DialogDescription>
          </DialogHeader>
          {open ? (
            <DocumentLibraryViewer
              key={`${scope.relay}:${scope.owner}:${scope.agent}`}
              scope={scope}
            />
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}

function DocumentLibraryViewer({ scope }: { scope: ComputerScope }) {
  const [rows, setRows] = React.useState<DocumentMeta[]>([]);
  const [cursor, setCursor] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");
  const [loaded, setLoaded] = React.useState(false);
  const life = React.useRef({
    active: false,
    revision: 0,
    controller: new AbortController(),
  });
  React.useEffect(() => {
    const lease = life.current;
    lease.active = true;
    return () => {
      lease.active = false;
      lease.revision++;
      lease.controller.abort();
    };
  }, []);
  async function read(next: boolean) {
    const lease = life.current;
    lease.controller.abort();
    lease.controller = new AbortController();
    const revision = ++lease.revision;
    const signal = lease.controller.signal;
    const live = () =>
      lease.active && lease.revision === revision && !signal.aborted;
    setBusy(true);
    setError("");
    try {
      const value = await documentLibrary(scope, next ? cursor : null, signal);
      if (!live()) return;
      setRows((old) =>
        next
          ? [
              ...old,
              ...value.documents.filter(
                (item) =>
                  !old.some((row) => row.document_id === item.document_id),
              ),
            ]
          : value.documents,
      );
      setCursor(value.next_cursor);
      setLoaded(true);
    } catch (failure) {
      if (live()) setError(documentError(failure));
    } finally {
      if (live()) setBusy(false);
    }
  }
  return (
    <div className="space-y-3" aria-busy={busy}>
      <Button
        size="sm"
        variant="outline"
        disabled={busy}
        onClick={() => void read(false)}
      >
        문서 목록 새로 고침
      </Button>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {busy ? (
        <p role="status" className="text-sm">
          문서 목록을 조회합니다.
        </p>
      ) : null}
      {loaded && !rows.length ? (
        <p className="text-sm">
          저장된 문서가 없거나 Desktop 접근이 허용되지 않았습니다.
        </p>
      ) : null}
      {rows.map((item) => (
        <section
          key={item.document_id}
          className="space-y-2 rounded-lg border p-3"
        >
          <h3 className="text-sm font-semibold">
            {item.source.role_id} · v{item.version}
          </h3>
          <p className="break-all text-xs">작업: {item.source.task_id}</p>
          <p className="text-xs text-muted-foreground">
            {new Date(item.saved_at * 1000).toLocaleString("ko-KR")} ·{" "}
            {item.content_bytes.toLocaleString("ko-KR")} 바이트
          </p>
          <FmgDocumentLauncher scope={scope} taskId={item.source.task_id} />
        </section>
      ))}
      {cursor ? (
        <Button
          size="sm"
          variant="outline"
          disabled={busy || rows.length >= 1000}
          onClick={() => void read(true)}
        >
          다음 문서 20건
        </Button>
      ) : null}
    </div>
  );
}
