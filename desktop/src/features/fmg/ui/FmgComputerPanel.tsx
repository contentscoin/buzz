import * as React from "react";
import { Monitor, RefreshCw } from "lucide-react";
import { z } from "zod";
import { useRelayAgentsQuery } from "@/features/agents/hooks";
import { useCommunities } from "@/features/communities/useCommunities";
import { useIdentityQuery } from "@/shared/api/hooks";
import { useDocumentVisible } from "@/shared/lib/useDocumentVisible";
import { Button } from "@/shared/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";
import {
  computerRelayOrigin,
  computerStateSchema,
  decryptComputerCapture,
  requestComputer,
  type ComputerScope,
  type ComputerState,
} from "../computerRpc";

/** OpenDots-derived observation flow, using Buzz's owner-encrypted transport. */
export function FmgComputerLauncher() {
  const [open, setOpen] = React.useState(false);
  const { activeCommunity } = useCommunities();
  const identity = useIdentityQuery();
  const agents = useRelayAgentsQuery();
  const owner = identity.data?.pubkey;
  const owned = (agents.data ?? []).filter(
    (agent) => agent.ownerPubkey === owner,
  );
  const [selected, setSelected] = React.useState("");
  const agent =
    owned.find((item) => item.pubkey === selected) ??
    owned.find(
      (item) => item.agentType === "openclaw" || /openclaw/i.test(item.name),
    ) ??
    owned[0];
  const relayUrl = activeCommunity?.relayUrl;
  const agentPubkey = agent?.pubkey;
  const scope = React.useMemo<ComputerScope | undefined>(() => {
    try {
      if (relayUrl && owner && agentPubkey)
        return {
          relay: computerRelayOrigin(relayUrl),
          owner,
          agent: agentPubkey,
        };
    } catch {
      /* Unsupported relay is displayed below. */
    }
    return undefined;
  }, [relayUrl, owner, agentPubkey]);
  return (
    <>
      <Button onClick={() => setOpen(true)} size="sm" variant="outline">
        <Monitor />
        서버 작업 화면 열기
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-5xl">
          <DialogHeader>
            <DialogTitle>서버 작업 화면</DialogTitle>
            <DialogDescription>
              Hostinger 브라우저 상태·탭·본문·화면을 조회합니다. 마지막으로
              조회한 화면이며, 조작과 작업 배정은 아직 제공하지 않습니다.
            </DialogDescription>
          </DialogHeader>
          <label className="flex items-center gap-3 text-sm">
            소유한 에이전트
            <select
              aria-label="서버 조회 에이전트"
              className="min-w-0 rounded-md border bg-background p-2"
              value={agent?.pubkey ?? ""}
              onChange={(event) => setSelected(event.target.value)}
            >
              {owned.map((item) => (
                <option key={item.pubkey} value={item.pubkey}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          {open && scope ? (
            <ComputerViewer
              key={`${activeCommunity?.id}:${scope.relay}:${scope.owner}:${scope.agent}`}
              scope={scope}
            />
          ) : (
            <p className="text-sm text-muted-foreground">
              현재 커뮤니티에서 소유한 서버 에이전트를 확인할 수 없습니다.
            </p>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

function ComputerViewer({ scope }: { scope: ComputerScope }) {
  const [state, setState] = React.useState<ComputerState>();
  const [selected, setSelected] = React.useState("");
  const [text, setText] = React.useState("");
  const [image, setImage] = React.useState("");
  const [audit, setAudit] = React.useState<
    { id: string; at: number; completed: number }[]
  >([]);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");
  const [checkedAt, setCheckedAt] = React.useState("");
  const [automatic, setAutomatic] = React.useState(false);
  const visible = useDocumentVisible();
  const lifecycle = React.useRef({
    active: true,
    busy: false,
    revision: 0,
    controller: new AbortController(),
    image: "",
  });
  const clearMedia = React.useCallback(() => {
    if (lifecycle.current.image) URL.revokeObjectURL(lifecycle.current.image);
    lifecycle.current.image = "";
    setImage("");
    setText("");
  }, []);

  const refresh = React.useCallback(
    async (
      action: string,
      target: { generation?: string; tabHandle?: string } = {},
    ) => {
      const life = lifecycle.current;
      if (!life.active || life.busy) return;
      life.busy = true;
      const revision = ++life.revision;
      setBusy(true);
      setError("");
      const current = () =>
        life.active &&
        life.revision === revision &&
        !life.controller.signal.aborted;
      try {
        const response = await requestComputer(
          scope,
          action,
          target,
          life.controller.signal,
        );
        if (!current()) return;
        if (action === "state.get") {
          const next = computerStateSchema.parse(response.result);
          if (
            state &&
            (state.generation !== next.generation ||
              !next.tabs.some(
                (tab) =>
                  tab.handle === selected &&
                  tab.url ===
                    state.tabs.find((item) => item.handle === selected)?.url,
              ))
          )
            clearMedia();
          setState(next);
          if (!next.tabs.some((tab) => tab.handle === selected))
            setSelected("");
        } else if (action === "tab.read") {
          const value = z
            .object({ text: z.string().max(8000) })
            .parse(response.result);
          clearMedia();
          setText(value.text || "본문이 비어 있습니다.");
        } else if (action === "screen.capture") {
          const blob = await decryptComputerCapture(
            scope,
            response,
            life.controller.signal,
          );
          if (!current()) return;
          clearMedia();
          const url = URL.createObjectURL(blob);
          life.image = url;
          setImage(url);
        } else if (action === "transcript.list") {
          setAudit(
            z
              .object({
                receipts: z
                  .array(
                    z.object({
                      id: z.uuid(),
                      at: z.number(),
                      completed: z.number().int(),
                    }),
                  )
                  .max(30),
              })
              .parse(response.result).receipts,
          );
        }
        setCheckedAt(response.checkedAt);
      } catch (failure) {
        if (current()) {
          clearMedia();
          setError(
            failure instanceof Error ? failure.message : "조회에 실패했습니다.",
          );
        }
      } finally {
        if (life.active && life.revision === revision) {
          life.busy = false;
          setBusy(false);
        }
      }
    },
    [scope, selected, state, clearMedia],
  );

  const initialRefresh = React.useRef(refresh);
  // Mount/close/identity/relay/agent changes revoke all pending work and media.
  React.useEffect(() => {
    const life = lifecycle.current;
    life.active = true;
    life.controller = new AbortController();
    life.busy = false;
    void initialRefresh.current("state.get");
    return () => {
      life.active = false;
      life.revision++;
      life.controller.abort();
      if (life.image) URL.revokeObjectURL(life.image);
      life.image = "";
    };
  }, []);
  React.useEffect(() => {
    if (!automatic || !visible || busy) return;
    const timer = setTimeout(() => void refresh("state.get"), 4000);
    return () => clearTimeout(timer);
  }, [automatic, visible, busy, refresh]);

  const choose = (handle: string) => {
    const life = lifecycle.current;
    life.revision++;
    life.controller.abort();
    life.controller = new AbortController();
    life.busy = false;
    setBusy(false);
    clearMedia();
    setSelected(handle);
    setError("");
  };
  const target = { generation: state?.generation, tabHandle: selected };
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-sm font-medium">
          {state
            ? `${state.profile} · ${state.running ? (state.ready ? "조회 가능" : "준비 중") : "브라우저 중지됨"}`
            : "연결 확인 중"}
        </span>
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => void refresh("state.get")}
        >
          <RefreshCw className={busy ? "animate-spin" : ""} />
          상태 새로 고침
        </Button>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={automatic}
            onChange={(event) => setAutomatic(event.target.checked)}
          />
          상태 자동 갱신
        </label>
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => void refresh("transcript.list")}
        >
          조회 이력
        </Button>
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {checkedAt ? (
        <p className="text-xs text-muted-foreground">
          마지막 조회: {new Date(checkedAt).toLocaleString("ko-KR")} · 화면은
          개별 새로 고침
        </p>
      ) : null}
      <div className="grid gap-4 md:grid-cols-[16rem_1fr]">
        <nav aria-label="서버 브라우저 탭" className="space-y-2">
          {state?.tabs.map((tab) => (
            <button
              key={tab.handle}
              type="button"
              aria-pressed={selected === tab.handle}
              onClick={() => choose(tab.handle)}
              className={`w-full rounded-lg border p-3 text-left ${selected === tab.handle ? "border-primary bg-muted" : "border-border"}`}
            >
              <span className="block break-words text-sm font-medium">
                {tab.title}
              </span>
              <span className="block break-all text-xs text-muted-foreground">
                {tab.url}
              </span>
            </button>
          ))}
          {state && state.tabs.length === 0 ? (
            <p className="text-sm text-muted-foreground">열린 탭이 없습니다.</p>
          ) : null}
        </nav>
        <section
          aria-label="선택한 탭의 조회 결과"
          className="min-w-0 space-y-3 rounded-lg border p-4"
        >
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              disabled={busy || !selected || !state?.ready}
              onClick={() => void refresh("screen.capture", target)}
            >
              화면 새로 고침
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy || !selected || !state?.ready}
              onClick={() => void refresh("tab.read", target)}
            >
              본문 읽기
            </Button>
          </div>
          {image ? (
            <img
              src={image}
              alt="Hostinger 서버 브라우저에서 마지막으로 조회한 화면"
              className="h-auto w-full rounded-md"
            />
          ) : text ? (
            <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words text-sm">
              {text}
            </pre>
          ) : (
            <p className="text-sm text-muted-foreground">
              탭을 선택한 뒤 화면이나 본문을 조회하세요.
            </p>
          )}
        </section>
      </div>
      {audit.length ? (
        <details>
          <summary className="cursor-pointer text-sm">
            최근 요청 {audit.length}건
          </summary>
          <ul className="space-y-1 pt-2 text-xs">
            {audit.map((row) => (
              <li key={row.id}>
                {new Date(row.at).toLocaleString("ko-KR")} ·{" "}
                {row.completed ? "응답 기록됨" : "응답 미확정"} · {row.id}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}
