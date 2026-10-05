import * as React from "react";
import { useCommunities } from "@/features/communities/useCommunities";
import { useIdentityQuery } from "@/shared/api/hooks";
import { invokeTauri } from "@/shared/api/tauri";
import type { ManagedAgent, RelayAgent } from "@/shared/api/types";
import { normalizePubkey } from "@/shared/lib/pubkey";
import { Button } from "@/shared/ui/button";
import { AgentIdentityCard } from "./AgentIdentityCard";
import { IDENTITY_CARD_GRID_CLASS } from "./UnifiedAgentsSection";

/** Relay identities are displayed without borrowing local runtime controls. */
export function OwnedRelayAgentsSection({
  agents,
  managedAgents,
  loading,
  error,
  onRefresh,
  onOpenProfile,
}: {
  agents: readonly RelayAgent[] | undefined;
  managedAgents: readonly ManagedAgent[] | undefined;
  loading: boolean;
  error: unknown;
  onRefresh: () => void;
  onOpenProfile: (pubkey: string) => void;
}) {
  const { activeCommunity } = useCommunities();
  const identity = useIdentityQuery();
  const owner = normalizePubkey(identity.data?.pubkey ?? "");
  const relay = activeCommunity?.relayUrl;
  const scope = `${relay ?? ""}:${owner}`;
  const currentScope = React.useRef(scope);
  currentScope.current = scope;
  const [pending, setPending] = React.useState<string | null>(null);
  const [feedback, setFeedback] = React.useState<{
    scope: string;
    error: string;
  } | null>(null);
  const owned = React.useMemo(() => {
    if (!owner || error) return [];
    const local = new Set(
      (managedAgents ?? []).map((agent) => normalizePubkey(agent.pubkey)),
    );
    const seen = new Set<string>();
    return (agents ?? []).filter((agent) => {
      const key = normalizePubkey(agent.pubkey);
      if (
        !agent.ownerPubkey ||
        normalizePubkey(agent.ownerPubkey) !== owner ||
        local.has(key) ||
        seen.has(key)
      )
        return false;
      seen.add(key);
      return true;
    });
  }, [agents, managedAgents, owner, error]);

  async function allowMentions(agent: RelayAgent) {
    if (!relay || !owner || pending) return;
    const capturedScope = scope;
    setPending(agent.pubkey);
    setFeedback(null);
    try {
      await invokeTauri<void>("allow_owned_relay_agent_mentions", {
        pubkey: agent.pubkey,
        expectedRelayUrl: relay,
        expectedSignerPubkey: owner,
      });
      if (currentScope.current === capturedScope) onRefresh();
    } catch (cause) {
      if (currentScope.current === capturedScope)
        setFeedback({ scope: capturedScope, error: String(cause) });
    } finally {
      setPending(null);
    }
  }

  return (
    <section className="space-y-3" aria-label="커뮤니티 소유 에이전트">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-base font-semibold">
          커뮤니티에서 확인된 에이전트
        </h2>
        <Button
          variant="outline"
          size="sm"
          disabled={loading || pending !== null}
          onClick={onRefresh}
        >
          목록 새로 고침
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">
        현재 커뮤니티에서 소유권이 확인된 에이전트입니다. 프로필에서 참여 채널을
        확인하세요.
      </p>
      {loading ? <p role="status">에이전트를 조회하고 있습니다.</p> : null}
      {error ? (
        <p role="alert">
          외부 에이전트 목록을 조회하지 못했습니다. 새로 고침해 주세요.
        </p>
      ) : null}
      {feedback?.scope === scope ? (
        <p role="alert" className="text-sm text-destructive">
          {feedback.error}
        </p>
      ) : null}
      {!loading && !error && owned.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          현재 계정에서 추가로 확인된 커뮤니티 에이전트가 없습니다.
        </p>
      ) : null}
      <div className={IDENTITY_CARD_GRID_CLASS}>
        {owned.map((agent) => (
          <AgentIdentityCard
            key={agent.pubkey}
            label={agent.name}
            ariaLabel={`${agent.name} 프로필 열기`}
            dataTestId="owned-relay-agent-card"
            onClick={() => onOpenProfile(agent.pubkey)}
            subtitle={
              agent.respondTo
                ? `참여 채널 ${agent.channelIds.length}개`
                : "멘션 응답 권한 등록 필요"
            }
            actions={
              !agent.respondTo ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={pending !== null || !relay}
                  onClick={() => void allowMentions(agent)}
                >
                  {pending === agent.pubkey ? "확인 중…" : "내 멘션 허용"}
                </Button>
              ) : undefined
            }
          />
        ))}
      </div>
      {owned.some((agent) => !agent.respondTo) ? (
        <p className="text-xs text-muted-foreground">
          ‘내 멘션 허용’은 본인만 요청할 수 있는 공개 응답 권한을 등록합니다.
          에이전트가 참여한 채널에서 사용하세요.
        </p>
      ) : null}
    </section>
  );
}
