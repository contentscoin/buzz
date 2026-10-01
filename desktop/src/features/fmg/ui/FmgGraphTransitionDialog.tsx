import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { getIdentity } from "@/shared/api/tauriIdentity";
import {
  getFmgGraphContext,
  transitionFmgGraphTask,
  type FmgGraphContext,
  type FmgGraphTask,
} from "@/shared/api/tauriFmg";
import type { FmgTaskGraphItem } from "@/features/fmg/useFmgTaskGraph";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import { Textarea } from "@/shared/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/shared/ui/dialog";

export function FmgGraphTransitionDialog({
  item,
  relayUrl,
  onClose,
  onAccepted,
}: {
  item: FmgTaskGraphItem;
  relayUrl: string;
  onClose: () => void;
  onAccepted: () => void;
}) {
  const contextQuery = useQuery({
    queryKey: [
      "fmg",
      "graph-context",
      relayUrl,
      item.repositoryId,
      item.issueId,
    ],
    retry: false,
    staleTime: 0,
    gcTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    queryFn: async () => {
      const identity = await getIdentity();
      const task: FmgGraphTask = {
        issue: item.issueId,
        repoOwner: item.repositoryOwner,
        repoId: item.repositoryDtag,
        relayUrl,
        signerPubkey: identity.pubkey,
      };
      const context = await getFmgGraphContext(task);
      return { task, context };
    },
  });
  const [pending, setPending] = React.useState(false);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
    >
      <DialogContent
        className="max-w-lg"
        onEscapeKeyDown={(event) => {
          if (pending) event.preventDefault();
        }}
        onInteractOutside={(event) => {
          if (pending) event.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle>작업 그래프 전환</DialogTitle>
          <DialogDescription>
            {item.title} · {item.projectName}
          </DialogDescription>
        </DialogHeader>
        {contextQuery.isFetching ? (
          <p role="status">권한·의존성·전환 이력을 확인하는 중입니다.</p>
        ) : contextQuery.isError ? (
          <div className="space-y-3" role="alert">
            <p>{String(contextQuery.error)}</p>
            <Button
              variant="outline"
              onClick={() => void contextQuery.refetch()}
            >
              새로 확인
            </Button>
          </div>
        ) : contextQuery.data ? (
          <TransitionForm
            key={contextQuery.dataUpdatedAt}
            task={contextQuery.data.task}
            context={contextQuery.data.context}
            pending={pending}
            setPending={setPending}
            onRefresh={() => void contextQuery.refetch()}
            onAccepted={onAccepted}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function TransitionForm({
  task,
  context,
  pending,
  setPending,
  onRefresh,
  onAccepted,
}: {
  task: FmgGraphTask;
  context: FmgGraphContext;
  pending: boolean;
  setPending: (value: boolean) => void;
  onRefresh: () => void;
  onAccepted: () => void;
}) {
  const id = React.useId();
  const [from, setFrom] = React.useState(context.state ?? "pending");
  const [to, setTo] = React.useState("");
  const [content, setContent] = React.useState("");
  const [gate, setGate] = React.useState("");
  const [error, setError] = React.useState("");
  const [accepted, setAccepted] = React.useState(false);
  const [eventId, setEventId] = React.useState("");
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (pending || error || accepted) return;
    setPending(true);
    try {
      const result = await transitionFmgGraphTask({
        task,
        from,
        to,
        content,
        gate: gate.trim() || null,
        expectedHead: context.head,
      });
      setAccepted(true);
      setEventId(result.event_id);
      onAccepted();
    } catch (failure) {
      setError(String(failure));
    } finally {
      setPending(false);
    }
  }
  return (
    <form className="space-y-4" onSubmit={(event) => void submit(event)}>
      <p className="text-sm text-muted-foreground">
        그래프 상태는 프로젝트의 Open·Closed 상태와 별도로 기록됩니다. 전환
        사유와 근거가 작업 이력에 게시됩니다.
      </p>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <label htmlFor={`${id}-from`} className="text-sm font-medium">
            {context.state ? "현재 그래프 상태" : "초기 그래프 상태"}
          </label>
          <Input
            id={`${id}-from`}
            value={from}
            readOnly={context.state !== null}
            disabled={pending || accepted}
            required
            maxLength={64}
            pattern="[a-z0-9-]+"
            onChange={(event) => setFrom(event.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <label htmlFor={`${id}-to`} className="text-sm font-medium">
            다음 그래프 상태
          </label>
          <Input
            id={`${id}-to`}
            value={to}
            disabled={pending || accepted}
            required
            maxLength={64}
            pattern="[a-z0-9-]+"
            placeholder="in-progress"
            onChange={(event) => setTo(event.target.value)}
          />
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        상태 이름은 영문 소문자·숫자·하이픈으로 입력하세요.
      </p>
      <div className="space-y-1.5">
        <label htmlFor={`${id}-reason`} className="text-sm font-medium">
          전환 사유·근거
        </label>
        <Textarea
          id={`${id}-reason`}
          value={content}
          disabled={pending || accepted}
          required
          maxLength={4096}
          onChange={(event) => setContent(event.target.value)}
        />
      </div>
      <div className="space-y-1.5">
        <label htmlFor={`${id}-gate`} className="text-sm font-medium">
          검증 항목 이름 (선택)
        </label>
        <Input
          id={`${id}-gate`}
          value={gate}
          disabled={pending || accepted}
          maxLength={64}
          pattern="[a-z0-9-]*"
          placeholder="tests / human-approval"
          onChange={(event) => setGate(event.target.value)}
        />
        <p className="text-xs text-muted-foreground">
          검증 항목 이름은 기록용입니다. 검수나 승인을 자동으로 수행하지
          않습니다.
        </p>
      </div>
      {error ? (
        <div role="alert" className="space-y-2">
          <p className="text-sm text-destructive">{error}</p>
          <p className="text-xs">
            전송 여부를 확인하려면 이력을 새로 불러오세요.
          </p>
          <Button type="button" variant="outline" onClick={onRefresh}>
            이력 새로 확인
          </Button>
        </div>
      ) : null}
      {accepted ? (
        <p role="status" className="break-all text-sm">
          릴레이가 전환을 승인했습니다. 기록: {eventId}
        </p>
      ) : (
        <Button
          type="submit"
          disabled={
            pending ||
            !!error ||
            !from.trim() ||
            !to.trim() ||
            from === to ||
            !content.trim() ||
            content.trim() === "-"
          }
        >
          {pending ? "검증·전송 중…" : "검증 후 상태 전환"}
        </Button>
      )}
    </form>
  );
}
