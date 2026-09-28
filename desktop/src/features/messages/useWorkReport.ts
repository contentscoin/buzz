import * as React from "react";

import { reduceWorkReports } from "@/features/messages/lib/workReport";
import {
  startWorkReportEventSync,
  type WorkReportEventSync,
} from "@/features/messages/workReportEventSync";
import type { RelayEvent } from "@/shared/api/types";
import { KIND_WORK_REPORT } from "@/shared/constants/kinds";

const THREAD_WORK_REPORT_LIMIT = 100;
const LIVE_OVERLAP_SECONDS = 5;

export function workReportQueryKey(channelId: string, rootId: string) {
  return ["work-report", channelId, rootId] as const;
}

export function useWorkReport(channelId: string | null, rootId: string | null) {
  const key = React.useMemo(
    () => workReportQueryKey(channelId ?? "none", rootId ?? "none"),
    [channelId, rootId],
  );
  const scopeKey = key.join("\n");
  const enabled = channelId !== null && rootId !== null;
  const [state, setState] = React.useState<{
    scopeKey: string;
    events: readonly RelayEvent[];
    isPending: boolean;
    isFetching: boolean;
    error: unknown | null;
    liveSubscriptionFailed: boolean;
  }>({
    scopeKey,
    events: [],
    isPending: enabled,
    isFetching: false,
    error: null,
    liveSubscriptionFailed: false,
  });
  const syncRef = React.useRef<WorkReportEventSync | null>(null);

  React.useEffect(() => {
    if (!channelId || !rootId) return;
    setState({
      scopeKey,
      events: [],
      isPending: true,
      isFetching: false,
      error: null,
      liveSubscriptionFailed: false,
    });
    const since = Math.max(
      0,
      Math.floor(Date.now() / 1_000) - LIVE_OVERLAP_SECONDS,
    );
    const update = (patch: Partial<Omit<typeof state, "scopeKey">>) =>
      setState((current) =>
        current.scopeKey === scopeKey ? { ...current, ...patch } : current,
      );
    const sync = startWorkReportEventSync({
      liveFilter: {
        kinds: [KIND_WORK_REPORT],
        limit: THREAD_WORK_REPORT_LIMIT,
        since,
        "#h": [channelId],
        "#e": [rootId],
      },
      historyFilter: {
        kinds: [KIND_WORK_REPORT],
        limit: THREAD_WORK_REPORT_LIMIT,
        "#h": [channelId],
        "#e": [rootId],
      },
      maxEvents: THREAD_WORK_REPORT_LIMIT,
      onSnapshot: (events) => update({ events }),
      onInitialLoadingChange: (isPending) => update({ isPending }),
      onFetchingChange: (isFetching) => update({ isFetching }),
      onHistoryError: (error) => update({ error }),
      onLiveSubscriptionFailed: (liveSubscriptionFailed) =>
        update({ liveSubscriptionFailed }),
    });
    syncRef.current = sync;
    return () => {
      if (syncRef.current === sync) syncRef.current = null;
      sync.dispose();
    };
  }, [channelId, rootId, scopeKey]);

  const current = state.scopeKey === scopeKey;
  const events = current ? state.events : [];
  const data = React.useMemo(
    () =>
      channelId && rootId ? reduceWorkReports(events, channelId, rootId) : null,
    [channelId, events, rootId],
  );
  const refetch = React.useCallback(
    () => syncRef.current?.refresh() ?? Promise.resolve(),
    [],
  );

  return {
    data,
    error: current ? state.error : null,
    isError: current && state.error !== null,
    isFetching: current && state.isFetching,
    isLoading: enabled && (!current || state.isPending),
    // Preserve TanStack Query's disabled-query contract. The thread panel uses
    // pending=true to avoid applying work-report presentation state when the
    // report hook is intentionally disabled (for example huddle transcripts).
    isPending: !enabled || !current || state.isPending,
    liveSubscriptionFailed: current && state.liveSubscriptionFailed,
    refetch,
  };
}
