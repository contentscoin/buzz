import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { getVersion } from "@tauri-apps/api/app";
import {
  Bot,
  CheckCircle2,
  ChevronRight,
  CircleHelp,
  Cloud,
  GitBranch,
  Globe2,
  RefreshCw,
  Smartphone,
  Wrench,
} from "lucide-react";

import { useAppNavigation } from "@/app/navigation/useAppNavigation";
import {
  useManagedAgentsQuery,
  useRelayAgentsQuery,
} from "@/features/agents/hooks";
import { useChannelsQuery } from "@/features/channels/hooks";
import { useCommunities } from "@/features/communities/useCommunities";
import { useFmgTaskGraph } from "@/features/fmg/useFmgTaskGraph";
import { useFmgWorkReports } from "@/features/fmg/useFmgWorkReports";
import type { WorkReportStatus } from "@/features/messages/lib/workReport";
import type { ConnectionState } from "@/shared/api/relayClientShared";
import { getFmgRuntimeStatus } from "@/shared/api/tauriFmg";
import { useRelayConnection } from "@/shared/api/useRelayConnection";
import { Badge, type BadgeProps } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";
import { Card, CardContent, CardHeader } from "@/shared/ui/card";
import { PageHeader, SectionHeader } from "@/shared/ui/PageHeader";

const RELAY_STATE_LABEL: Record<ConnectionState, string> = {
  idle: "연결 대기",
  connecting: "연결 중",
  connected: "연결됨",
  reconnecting: "다시 연결 중",
  stalled: "응답 지연",
  disconnected: "연결 끊김",
};

const REPORT_STATUS_LABEL: Record<WorkReportStatus, string> = {
  completed: "완료",
  in_review: "검토 중",
  needs_decision: "결정 필요",
  blocked: "차단됨",
  failed: "실패",
};

const AGENT_STATUS_LABEL = {
  online: "온라인",
  away: "자리 비움",
  offline: "오프라인",
  unknown: "상태 미확인",
} as const;

const REPORT_STATUS_VARIANT: Record<
  WorkReportStatus,
  NonNullable<BadgeProps["variant"]>
> = {
  completed: "success",
  in_review: "info",
  needs_decision: "warning",
  blocked: "warning",
  failed: "destructive",
};

function relayVariant(
  state: ConnectionState,
): NonNullable<BadgeProps["variant"]> {
  if (state === "connected") return "success";
  if (state === "connecting" || state === "reconnecting") return "warning";
  if (state === "idle") return "secondary";
  return "destructive";
}

function formatReportTime(unixSeconds: number): string {
  return new Intl.DateTimeFormat("ko-KR", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date(unixSeconds * 1_000));
}

function Metric({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="min-w-0 space-y-1 rounded-lg bg-muted/45 px-3 py-2.5">
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words text-sm font-semibold">{value}</dd>
    </div>
  );
}

function FeatureCard({
  action,
  badge,
  children,
  description,
  icon,
  title,
}: {
  action?: React.ReactNode;
  badge: React.ReactNode;
  children?: React.ReactNode;
  description: React.ReactNode;
  icon: React.ReactNode;
  title: string;
}) {
  return (
    <Card className="flex min-w-0 flex-col">
      <CardHeader className="space-y-3 p-5 pb-3">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2.5">
            <span
              aria-hidden="true"
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted text-foreground"
            >
              {icon}
            </span>
            <h3 className="text-base font-semibold">{title}</h3>
          </div>
          {badge}
        </div>
        <p className="text-sm leading-relaxed text-muted-foreground">
          {description}
        </p>
      </CardHeader>
      {(children || action) && (
        <CardContent className="flex flex-1 flex-col gap-4 p-5 pt-0">
          {children}
          {action ? <div className="mt-auto">{action}</div> : null}
        </CardContent>
      )}
    </Card>
  );
}

export function FmgDashboard() {
  const { goAgents, goChannel, goProject, goProjects, goSettings } =
    useAppNavigation();
  const { activeCommunity } = useCommunities();
  const relayState = useRelayConnection();
  const channelsQuery = useChannelsQuery();
  const managedAgentsQuery = useManagedAgentsQuery();
  const relayAgentsQuery = useRelayAgentsQuery();
  const taskGraphQuery = useFmgTaskGraph();
  const workReportsQuery = useFmgWorkReports();
  const runtimeStatusQuery = useQuery({
    queryKey: ["fmg", "runtime-status"],
    queryFn: getFmgRuntimeStatus,
    staleTime: Number.POSITIVE_INFINITY,
  });
  const versionQuery = useQuery({
    queryKey: ["fmg", "desktop-version"],
    queryFn: getVersion,
    staleTime: Number.POSITIVE_INFINITY,
  });
  const [showAllReports, setShowAllReports] = React.useState(false);
  const [showAllGraphItems, setShowAllGraphItems] = React.useState(false);

  const channelsById = React.useMemo(
    () =>
      new Map(
        (channelsQuery.data ?? []).map((channel) => [channel.id, channel]),
      ),
    [channelsQuery.data],
  );
  const relayAgents = relayAgentsQuery.data ?? [];
  const managedAgents = managedAgentsQuery.data ?? [];
  const onlineAgentCount = relayAgents.filter(
    (agent) => agent.status === "online",
  ).length;
  const activeManagedAgentCount = managedAgents.filter(
    (agent) => agent.status === "running" || agent.status === "deployed",
  ).length;
  const visibleReports = showAllReports
    ? workReportsQuery.items
    : workReportsQuery.items.slice(0, 5);
  const visibleGraphItems = showAllGraphItems
    ? taskGraphQuery.items
    : taskGraphQuery.items.slice(0, 4);
  const asideConfigured = runtimeStatusQuery.data?.asideBrowserConfigured;

  return (
    <div
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto overflow-x-hidden overscroll-contain px-4 py-7 sm:px-6 sm:py-8"
      data-testid="fmg-dashboard"
    >
      <div className="mx-auto w-full max-w-6xl space-y-8 [container-type:inline-size]">
        <PageHeader
          action={
            <Badge variant="info">
              FMG Buzz{versionQuery.data ? ` ${versionQuery.data}` : ""}
            </Badge>
          }
          description="이 빌드에 추가된 기능과 현재 연결 상태를 한곳에서 확인합니다."
          title="FMG 작업 센터"
        />

        <section aria-label="현재 상태" className="space-y-4">
          <SectionHeader
            description="앱이 지금 직접 확인한 값입니다."
            title="현재 상태"
          />
          <Card>
            <CardContent className="p-4 sm:p-5">
              <dl className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                <Metric
                  label="커뮤니티"
                  value={activeCommunity?.name ?? "연결된 커뮤니티 없음"}
                />
                <Metric
                  label="자체 릴레이"
                  value={
                    <span className="flex flex-wrap items-center gap-2">
                      <Badge variant={relayVariant(relayState)}>
                        {RELAY_STATE_LABEL[relayState]}
                      </Badge>
                      {activeCommunity ? (
                        <span className="break-all font-mono text-xs font-normal text-muted-foreground">
                          {activeCommunity.relayUrl}
                        </span>
                      ) : null}
                    </span>
                  }
                />
                <Metric
                  label="릴레이 에이전트"
                  value={
                    relayAgentsQuery.isLoading
                      ? "확인 중"
                      : relayAgentsQuery.isError
                        ? "확인 불가"
                        : `${onlineAgentCount} 온라인 · ${relayAgents.length} 확인됨`
                  }
                />
                <Metric
                  label="로컬·배포 에이전트"
                  value={
                    managedAgentsQuery.isLoading
                      ? "확인 중"
                      : managedAgentsQuery.isError
                        ? "확인 불가"
                        : `${activeManagedAgentCount} 활성 · ${managedAgents.length} 등록됨`
                  }
                />
              </dl>
            </CardContent>
          </Card>
        </section>

        <section aria-label="작업 결과" className="space-y-4">
          <SectionHeader
            action={
              <div className="flex items-center gap-1">
                {workReportsQuery.items.length > 5 ? (
                  <Button
                    aria-expanded={showAllReports}
                    onClick={() => setShowAllReports((value) => !value)}
                    size="sm"
                    type="button"
                    variant="ghost"
                  >
                    {showAllReports
                      ? "접기"
                      : `모두 보기 (${workReportsQuery.items.length})`}
                  </Button>
                ) : null}
                <Button
                  aria-label="작업 결과 새로 고침"
                  disabled={workReportsQuery.isFetching}
                  onClick={() => void workReportsQuery.refetch()}
                  size="icon"
                  type="button"
                  variant="ghost"
                >
                  <RefreshCw
                    className={
                      workReportsQuery.isFetching
                        ? "motion-safe:animate-spin"
                        : ""
                    }
                  />
                </Button>
              </div>
            }
            description="에이전트가 발행한 구조화된 결과를 최신순으로 표시합니다."
            title="작업 결과"
          />
          <Card>
            <CardContent className="p-0">
              {workReportsQuery.isLoading ? (
                <p
                  className="px-5 py-8 text-sm text-muted-foreground"
                  role="status"
                >
                  작업 결과를 불러오는 중입니다.
                </p>
              ) : workReportsQuery.isError ? (
                <div className="space-y-3 px-5 py-6" role="alert">
                  <p className="text-sm">
                    작업 결과를 불러오지 못했습니다. 연결을 확인하고 다시
                    시도하세요.
                  </p>
                  <Button
                    onClick={() => void workReportsQuery.refetch()}
                    size="sm"
                    type="button"
                    variant="outline"
                  >
                    다시 불러오기
                  </Button>
                </div>
              ) : visibleReports.length === 0 ? (
                <div className="space-y-2 px-5 py-8">
                  <p className="text-sm font-medium">
                    아직 작업 결과가 없습니다
                  </p>
                  <p className="text-sm text-muted-foreground">
                    에이전트가 완료·검토·차단 결과를 발행하면 이곳에서 바로 열
                    수 있습니다.
                  </p>
                </div>
              ) : (
                <ul className="divide-y divide-border/60">
                  {visibleReports.map(({ channelId, report, rootId }) => {
                    const channel = channelsById.get(channelId);
                    return (
                      <li
                        className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center"
                        key={`${channelId}:${rootId}`}
                      >
                        <div className="min-w-0 flex-1 space-y-1.5">
                          <div className="flex flex-wrap items-center gap-2">
                            <Badge
                              variant={REPORT_STATUS_VARIANT[report.status]}
                            >
                              {REPORT_STATUS_LABEL[report.status]}
                            </Badge>
                            <span className="text-xs text-muted-foreground">
                              {channel?.name ?? "알 수 없는 채널"} ·{" "}
                              {formatReportTime(report.createdAt)}
                            </span>
                          </div>
                          <p className="break-words text-sm font-medium leading-relaxed">
                            {report.outcome}
                          </p>
                        </div>
                        <Button
                          className="shrink-0 self-start sm:self-auto"
                          onClick={() =>
                            void goChannel(channelId, {
                              messageId: rootId,
                              threadRootId: rootId,
                            })
                          }
                          size="sm"
                          type="button"
                          variant="outline"
                        >
                          스레드 열기
                          <ChevronRight />
                        </Button>
                      </li>
                    );
                  })}
                </ul>
              )}
              {workReportsQuery.liveSubscriptionFailed ? (
                <p
                  className="border-t border-border/60 px-5 py-3 text-xs leading-relaxed text-amber-600 dark:text-amber-400"
                  role="status"
                >
                  자동 갱신 연결에 실패했습니다. 새로 고침 버튼으로 최신 결과를
                  확인하세요.
                </p>
              ) : null}
            </CardContent>
          </Card>
        </section>

        <section aria-label="FMG 기능" className="space-y-4">
          <SectionHeader
            description="화면에서 가능한 동작과 현재 제한을 함께 표시합니다."
            title="FMG 기능"
          />
          <div className="grid gap-4 md:grid-cols-2">
            <FeatureCard
              action={
                <Button
                  onClick={() => void goAgents()}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  에이전트 열기
                  <ChevronRight />
                </Button>
              }
              badge={<Badge variant="info">주기적 확인</Badge>}
              description="릴레이가 공개한 에이전트 이름과 presence를 표시합니다. 런타임 종류는 릴레이 정보만으로 단정하지 않습니다."
              icon={<Bot />}
              title="에이전트·OpenClaw 연계"
            >
              {relayAgentsQuery.isLoading ? (
                <p className="text-sm text-muted-foreground" role="status">
                  에이전트를 확인하는 중입니다.
                </p>
              ) : relayAgentsQuery.isError ? (
                <div className="space-y-2" role="alert">
                  <p className="text-sm text-muted-foreground">
                    에이전트 목록을 불러오지 못했습니다.
                  </p>
                  <Button
                    onClick={() => void relayAgentsQuery.refetch()}
                    size="sm"
                    type="button"
                    variant="ghost"
                  >
                    다시 불러오기
                  </Button>
                </div>
              ) : relayAgents.length > 0 ? (
                <ul className="space-y-2">
                  {relayAgents.slice(0, 4).map((agent) => (
                    <li
                      className="flex min-w-0 items-center justify-between gap-3 rounded-lg bg-muted/45 px-3 py-2"
                      key={agent.pubkey}
                    >
                      <span className="min-w-0 break-words text-sm font-medium">
                        {agent.name}
                      </span>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {AGENT_STATUS_LABEL[agent.status]}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground">
                  이 커뮤니티에서 확인된 원격 에이전트가 없습니다.
                </p>
              )}
            </FeatureCard>

            <FeatureCard
              action={
                <div className="flex flex-wrap gap-2">
                  {taskGraphQuery.items.length > 4 ? (
                    <Button
                      aria-expanded={showAllGraphItems}
                      onClick={() => setShowAllGraphItems((value) => !value)}
                      size="sm"
                      type="button"
                      variant="ghost"
                    >
                      {showAllGraphItems
                        ? "접기"
                        : `모두 보기 (${taskGraphQuery.items.length})`}
                    </Button>
                  ) : null}
                  <Button
                    onClick={() => void goProjects()}
                    size="sm"
                    type="button"
                    variant="outline"
                  >
                    프로젝트 열기
                    <ChevronRight />
                  </Button>
                </div>
              }
              badge={<Badge variant="warning">미리보기</Badge>}
              description="graph 라벨 작업, 프로젝트 상태와 의존성을 읽습니다. 그래프 전환 실행과 전환 이력의 상세 검증은 현재 에이전트 또는 buzz CLI에서 합니다."
              icon={<GitBranch />}
              title="작업 그래프"
            >
              {taskGraphQuery.isLoading ? (
                <p className="text-sm text-muted-foreground" role="status">
                  그래프 작업을 불러오는 중입니다.
                </p>
              ) : taskGraphQuery.error ? (
                <div className="space-y-2" role="alert">
                  <p className="text-sm text-muted-foreground">
                    그래프 작업을 불러오지 못했습니다.
                  </p>
                  <Button
                    onClick={() => {
                      void taskGraphQuery.projectsQuery.refetch();
                      void taskGraphQuery.workItemsQuery.refetch();
                    }}
                    size="sm"
                    type="button"
                    variant="ghost"
                  >
                    다시 불러오기
                  </Button>
                </div>
              ) : visibleGraphItems.length > 0 ? (
                <ul className="space-y-2">
                  {visibleGraphItems.map((item) => (
                    <li
                      className="rounded-lg bg-muted/45 px-3 py-2.5"
                      key={`${item.repositoryId}:${item.issueId}`}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="break-words text-sm font-medium">
                            {item.title}
                          </p>
                          <p className="mt-1 text-xs text-muted-foreground">
                            {item.projectName} · 프로젝트 상태{" "}
                            {item.status ?? "미확인"} · 유효 의존성{" "}
                            {item.dependencyIds.length}개
                          </p>
                          {item.invalidDependencyValues.length > 0 ? (
                            <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">
                              잘못된 의존성 태그{" "}
                              {item.invalidDependencyValues.length}개 · CLI 전환
                              불가
                            </p>
                          ) : null}
                        </div>
                        <Button
                          aria-label={`${item.title} 프로젝트에서 열기`}
                          onClick={() =>
                            void goProject(item.projectId, {
                              issueId: item.issueId,
                              repositoryId: item.repositoryId,
                            })
                          }
                          size="icon-xs"
                          type="button"
                          variant="ghost"
                        >
                          <ChevronRight />
                        </Button>
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="rounded-lg bg-muted/45 px-3 py-2.5 text-sm">
                  <p className="font-medium">graph 라벨 작업이 없습니다</p>
                  <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                    그래프 작업을 만들면 의존성과 현재 상태가 여기에 표시됩니다.
                  </p>
                </div>
              )}
              {taskGraphQuery.failedSections.length > 0 ? (
                <p className="text-xs leading-relaxed text-muted-foreground">
                  일부 이력을 불러오지 못해 상태가 완전하지 않을 수 있습니다.
                </p>
              ) : null}
            </FeatureCard>

            <FeatureCard
              action={
                <Button
                  onClick={() => void goSettings("agents")}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  에이전트 설정 열기
                  <ChevronRight />
                </Button>
              }
              badge={
                runtimeStatusQuery.isLoading ? (
                  <Badge variant="secondary">확인 중</Badge>
                ) : runtimeStatusQuery.isError ? (
                  <Badge variant="warning">확인 불가</Badge>
                ) : asideConfigured ? (
                  <Badge variant="success">설정됨</Badge>
                ) : (
                  <Badge variant="secondary">설정 필요</Badge>
                )
              }
              description={
                runtimeStatusQuery.isLoading
                  ? "이 데스크톱 프로세스의 Aside 설정을 확인하고 있습니다."
                  : runtimeStatusQuery.isError
                    ? "Aside 설정 여부를 읽지 못했습니다. 에이전트 설정과 앱 실행 환경을 확인하세요."
                    : asideConfigured
                      ? "이 데스크톱 프로세스에 Aside 명령이 설정되어 ACP 세션에서 브라우저 도구를 주입할 수 있습니다."
                      : "BUZZ_ACP_ASIDE_COMMAND를 설정하면 ACP 에이전트 세션에 Aside 브라우저 도구를 추가할 수 있습니다."
              }
              icon={runtimeStatusQuery.isError ? <CircleHelp /> : <Globe2 />}
              title="Aside 브라우저"
            />

            <FeatureCard
              action={
                <Button
                  onClick={() => void goSettings("mobile")}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  모바일 설정 열기
                  <ChevronRight />
                </Button>
              }
              badge={<Badge variant="info">에이전트 정책</Badge>}
              description="모바일 Buzz에서는 구조화된 카드 대신 같은 스레드의 일반 답글로 핵심 결과를 받습니다. 전송은 에이전트 정책에 따른 최선 시도입니다."
              icon={<Smartphone />}
              title="모바일 결과 요약"
            />
          </div>
        </section>

        <section aria-label="확인 범위" className="space-y-4">
          <SectionHeader
            description="데스크톱이 직접 확인할 수 있는 범위를 명확히 표시합니다."
            title="확인 범위"
          />
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="flex gap-3 rounded-xl border border-border/70 p-4">
              <CheckCircle2
                aria-hidden="true"
                className="mt-0.5 h-5 w-5 shrink-0 text-emerald-500"
              />
              <div>
                <h3 className="text-sm font-semibold">직접 확인</h3>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  릴레이 연결, 에이전트 presence, 작업 결과
                </p>
              </div>
            </div>
            <div className="flex gap-3 rounded-xl border border-border/70 p-4">
              <Cloud
                aria-hidden="true"
                className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground"
              />
              <div>
                <h3 className="text-sm font-semibold">서버 연결</h3>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  현재 커뮤니티 WebSocket 상태와 공개 정보
                </p>
              </div>
            </div>
            <div className="flex gap-3 rounded-xl border border-border/70 p-4">
              <Wrench
                aria-hidden="true"
                className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground"
              />
              <div>
                <h3 className="text-sm font-semibold">운영자 기능</h3>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  서버 컨테이너와 배포 digest는 운영 도구에서 확인
                </p>
              </div>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
