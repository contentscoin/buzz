import * as React from "react";
import { ComputerRequestError, type ComputerScope } from "./computerRpc";
import {
  documentAccess,
  documentVersions,
  documentTaskSource,
  documentSource,
  documentError,
  getDocument,
  findDocumentRequest,
  saveDocument,
  type DocumentDetail,
  type DocumentMeta,
} from "./documentRpc";
import {
  emptyDocumentDraft,
  loadDocumentDraft,
  persistDocumentDraft,
  pendingDocumentSave,
  removeConfirmedDocumentDraft,
  type DocumentDraft,
} from "./documentDraft";

/** A mounted editor owns its encrypted journal, requests and generation fence. */
export function useDocumentEditor(scope: ComputerScope, taskId: string) {
  const [draft, setDraft] = React.useState<DocumentDraft>(emptyDocumentDraft);
  const [access, setAccess] = React.useState<{
    enabled: boolean;
    completion_verified: boolean;
  }>();
  const [versions, setVersions] = React.useState<DocumentMeta[]>([]);
  const [shown, setShown] = React.useState<DocumentDetail>();
  const [source, setSource] = React.useState<string>();
  const [latest, setLatest] = React.useState<DocumentDetail>();
  const [busy, setBusy] = React.useState(true);
  const [ready, setReady] = React.useState(false);
  const [error, setError] = React.useState("");
  const [notice, setNotice] = React.useState("");
  const [localStatus, setLocalStatus] = React.useState("로컬 초안 확인 중");
  const life = React.useRef({
    active: false,
    generation: 0,
    controller: new AbortController(),
  });
  const currentDraft = React.useRef(draft);
  const revision = React.useRef(0);
  const queue = React.useRef<Promise<void>>(Promise.resolve());
  const writes = React.useRef(0);
  const timer = React.useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const journalReady = React.useRef(false);
  const working = React.useRef(true);
  const clearedSnapshot = React.useRef<DocumentDraft | null>(null);

  function replace(next: DocumentDraft) {
    currentDraft.current = next;
    setDraft(next);
  }

  function flush(next = currentDraft.current): Promise<void> {
    clearTimeout(timer.current);
    if (next === clearedSnapshot.current) return Promise.resolve();
    if (!journalReady.current)
      return Promise.reject(
        new Error("로컬 초안이 복구되지 않아 기존 기록을 덮어쓰지 않았습니다."),
      );
    if (writes.current >= 2)
      return Promise.reject(
        new Error("로컬 초안 보관이 진행 중입니다. 잠시 후 다시 시도하세요."),
      );
    writes.current++;
    const generation = life.current.generation;
    const signal = life.current.controller.signal;
    setLocalStatus("암호화 초안 보관 중");
    const operation = queue.current
      .catch(() => undefined)
      .then(async () => {
        signal.throwIfAborted();
        revision.current = await persistDocumentDraft(
          scope,
          taskId,
          next,
          revision.current,
          signal,
        );
        if (
          life.current.active &&
          life.current.generation === generation &&
          currentDraft.current === next
        )
          setLocalStatus("암호화 초안 보관 완료");
      })
      .finally(() => {
        writes.current--;
      });
    queue.current = operation;
    return operation.catch((failure) => {
      if (life.current.active && life.current.generation === generation) {
        setError(documentError(failure));
        setLocalStatus("로컬 보관 실패 · 현재 초안 유지");
      }
      throw failure;
    });
  }

  React.useEffect(() => {
    const lease = life.current;
    lease.active = true;
    lease.controller = new AbortController();
    const generation = ++lease.generation;
    const signal = lease.controller.signal;
    const live = () =>
      lease.active && lease.generation === generation && !signal.aborted;
    journalReady.current = false;
    async function boot() {
      try {
        const restored = await loadDocumentDraft(scope, taskId, signal);
        if (!live()) return;
        revision.current = restored?.revision ?? 0;
        journalReady.current = true;
        const loaded = restored?.draft ?? { ...emptyDocumentDraft };
        currentDraft.current = loaded;
        setDraft(loaded);
        setReady(true);
        setLocalStatus(
          restored ? "암호화 초안 복구 완료" : "새 초안 · 아직 보관되지 않음",
        );
        const allowed = await documentAccess(scope, taskId, signal);
        if (!live()) return;
        setAccess(allowed);
        if (allowed.enabled) {
          const rows = await documentVersions(scope, taskId, signal);
          if (!live()) return;
          setVersions(rows);
          if (!restored && rows[0]) {
            const item = await getDocument(
              scope,
              taskId,
              rows[0].document_id,
              rows[0].version,
              signal,
            );
            if (!live()) return;
            setShown(item);
            const initial = {
              markdown: item.markdown,
              documentId: item.document_id,
              baseVersion: item.current_version,
              pending: null,
            };
            currentDraft.current = initial;
            setDraft(initial);
          } else if (!restored && allowed.completion_verified) {
            const original = await documentTaskSource(scope, taskId, signal);
            if (!live()) return;
            setSource(original);
            // Large originals remain readable without silently truncating them.
            if (new TextEncoder().encode(original).length <= 32768) {
              const initial = { ...loaded, markdown: original };
              currentDraft.current = initial;
              setDraft(initial);
            } else
              setNotice(
                "보관된 원본이 초안 한도를 초과합니다. 원본을 보며 32KiB 이내로 작성하세요.",
              );
          }
        }
        if (restored?.draft.pending)
          setNotice(
            "확인되지 않은 저장 요청이 복구됐습니다. 먼저 저장 결과를 확인하세요.",
          );
      } catch (failure) {
        if (live()) setError(documentError(failure));
      } finally {
        if (live()) {
          working.current = false;
          setBusy(false);
        }
      }
    }
    void boot();
    return () => {
      lease.active = false;
      lease.generation++;
      lease.controller.abort();
      clearTimeout(timer.current);
      journalReady.current = false;
    };
  }, [scope, taskId]);

  function edit(markdown: string) {
    replace({ ...currentDraft.current, markdown });
    setLocalStatus("보관되지 않은 변경사항");
    clearTimeout(timer.current);
    function autosave() {
      if (!life.current.active) return;
      if (writes.current) {
        timer.current = setTimeout(autosave, 800);
        return;
      }
      void flush().catch((failure) => {
        if (life.current.active) {
          setError(documentError(failure));
          setLocalStatus("로컬 보관 실패 · 현재 초안 유지");
        }
      });
    }
    timer.current = setTimeout(autosave, 800);
  }

  async function run(
    work: (signal: AbortSignal, live: () => boolean) => Promise<void>,
  ) {
    if (working.current || !ready || !life.current.active) return;
    const generation = life.current.generation;
    const signal = life.current.controller.signal;
    const live = () =>
      life.current.active &&
      life.current.generation === generation &&
      !signal.aborted;
    working.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await work(signal, live);
    } catch (failure) {
      if (live()) setError(documentError(failure));
    } finally {
      if (live()) {
        working.current = false;
        setBusy(false);
      }
    }
  }

  async function accepted(item: DocumentDetail, live: () => boolean) {
    if (!live()) return;
    const pending = currentDraft.current.pending;
    if (
      !pending ||
      item.request_id !== pending.saveRequestId ||
      item.markdown !== pending.markdown
    )
      throw new Error(
        "저장 결과가 원래 요청과 일치하지 않습니다. 미확인 요청을 유지했습니다.",
      );
    const next = {
      ...currentDraft.current,
      documentId: item.document_id,
      baseVersion: item.version,
      pending: null,
    };
    await flush(next);
    if (!live()) return;
    replace(next);
    setLocalStatus("암호화 초안 보관 완료");
    setShown(item);
    setVersions((rows) =>
      [item, ...rows.filter((row) => row.version !== item.version)].sort(
        (a, b) => b.version - a.version,
      ),
    );
    setNotice(`버전 ${item.version} 저장 확인 완료`);
  }

  function save(retry = false) {
    return run(async (signal, live) => {
      if (!access?.enabled || !access.completion_verified)
        throw new Error(
          "Desktop 접근 허용과 실제 성공 종료 확인이 필요합니다.",
        );
      if (currentDraft.current.pending && !retry)
        throw new Error("기존 요청의 저장 결과부터 확인하세요.");
      const pending =
        currentDraft.current.pending ??
        pendingDocumentSave(taskId, currentDraft.current);
      const next = { ...currentDraft.current, pending };
      replace(next);
      await flush(next); // No network save until the exact UUID/payload is durable.
      try {
        const item = await saveDocument(scope, pending, signal);
        await accepted(item, live);
      } catch (failure) {
        if (
          live() &&
          failure instanceof ComputerRequestError &&
          [
            "version_conflict",
            "version_capacity",
            "storage_capacity",
            "request_capacity",
            "content_too_large",
            "completion_evidence_unavailable",
            "desktop_access_required",
            "access_denied",
            "rate_limited",
          ].includes(failure.code)
        ) {
          const retained = { ...currentDraft.current, pending: null };
          await flush(retained);
          if (live()) replace(retained);
        }
        throw failure;
      }
    });
  }

  function recover() {
    return run(async (signal, live) => {
      const pending = currentDraft.current.pending;
      if (!pending) return;
      await accepted(
        await findDocumentRequest(scope, taskId, pending.saveRequestId, signal),
        live,
      );
    });
  }

  function inspect(version: DocumentMeta) {
    return run(async (signal, live) => {
      const item = await getDocument(
        scope,
        taskId,
        version.document_id,
        version.version,
        signal,
      );
      if (live()) {
        setShown(item);
        setSource(undefined);
      }
    });
  }

  function compare() {
    return run(async (signal, live) => {
      const rows = await documentVersions(scope, taskId, signal);
      if (!live()) return;
      setVersions(rows);
      if (!rows[0]) throw new Error("비교할 저장 문서가 없습니다.");
      const item = await getDocument(
        scope,
        taskId,
        rows[0].document_id,
        null,
        signal,
      );
      if (live()) setLatest(item);
    });
  }

  function useLatestBase() {
    if (!latest || currentDraft.current.pending || busy) return;
    const next = {
      ...currentDraft.current,
      documentId: latest.document_id,
      baseVersion: latest.current_version,
    };
    replace(next);
    void flush(next).catch((failure) => {
      if (life.current.active) setError(documentError(failure));
    });
    setNotice(
      "내 초안은 유지했습니다. 다음 저장은 최신 버전을 기준으로 새 요청 UUID를 사용합니다.",
    );
  }

  function readSource() {
    return run(async (signal, live) => {
      const original = shown
        ? await documentSource(scope, shown, signal)
        : await documentTaskSource(scope, taskId, signal);
      if (live()) setSource(original);
    });
  }

  function refreshAccess() {
    return run(async (signal, live) => {
      const allowed = await documentAccess(scope, taskId, signal);
      if (!live()) return;
      setAccess(allowed);
      if (allowed.enabled) {
        const rows = await documentVersions(scope, taskId, signal);
        if (live()) setVersions(rows);
      }
    });
  }

  function clearLocal() {
    return run(async (signal, live) => {
      const snapshot = currentDraft.current;
      if (
        snapshot.pending ||
        !shown ||
        !snapshot.documentId ||
        snapshot.markdown !== shown.markdown ||
        snapshot.documentId !== shown.document_id
      )
        throw new Error(
          "서버에서 확인한 내용과 동일하고 미확인 요청이 없을 때만 로컬 보관을 정리할 수 있습니다.",
        );
      clearTimeout(timer.current);
      await queue.current;
      await removeConfirmedDocumentDraft(
        scope,
        taskId,
        revision.current,
        signal,
      );
      if (!live()) return;
      revision.current = 0;
      clearedSnapshot.current = snapshot;
      setLocalStatus("서버 문서 유지 · 로컬 보관 정리 완료");
    });
  }

  return {
    draft,
    access,
    versions,
    shown,
    source,
    latest,
    busy,
    ready,
    error,
    notice,
    localStatus,
    edit,
    flush,
    save,
    recover,
    inspect,
    compare,
    useLatestBase,
    readSource,
    refreshAccess,
    clearLocal,
  };
}
