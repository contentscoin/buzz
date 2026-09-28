import * as React from "react";

import {
  reduceWorkReports,
  type WorkReport,
} from "@/features/messages/lib/workReport";
import {
  startWorkReportEventSync,
  type WorkReportEventSync,
} from "@/features/messages/workReportEventSync";
import type { RelayEvent } from "@/shared/api/types";
import { KIND_WORK_REPORT } from "@/shared/constants/kinds";

const RECENT_WORK_REPORT_LIMIT = 200;
const LIVE_OVERLAP_SECONDS = 5;

export type FmgWorkReportItem = {
  channelId: string;
  rootId: string;
  report: WorkReport;
};

function singleTag(event: RelayEvent, name: string): string | null {
  const values = event.tags.filter((tag) => tag[0] === name);
  return values.length === 1 ? (values[0][1] ?? null) : null;
}

function rootId(event: RelayEvent): string | null {
  const roots = event.tags.filter((tag) => tag[0] === "e" && tag[3] === "root");
  return roots.length === 1 ? (roots[0][1] ?? null) : null;
}

function latestReports(events: readonly RelayEvent[]): FmgWorkReportItem[] {
  const eventsByChannelAndRoot = new Map<string, Map<string, RelayEvent[]>>();

  for (const event of events) {
    const channelId = singleTag(event, "h");
    const reportRootId = rootId(event);
    if (!channelId || !reportRootId) continue;

    let eventsByRoot = eventsByChannelAndRoot.get(channelId);
    if (!eventsByRoot) {
      eventsByRoot = new Map();
      eventsByChannelAndRoot.set(channelId, eventsByRoot);
    }
    const scopedEvents = eventsByRoot.get(reportRootId) ?? [];
    scopedEvents.push(event);
    eventsByRoot.set(reportRootId, scopedEvents);
  }

  const items: FmgWorkReportItem[] = [];
  for (const [channelId, eventsByRoot] of eventsByChannelAndRoot) {
    for (const [reportRootId, scopedEvents] of eventsByRoot) {
      const report = reduceWorkReports(scopedEvents, channelId, reportRootId);
      if (report) items.push({ channelId, rootId: reportRootId, report });
    }
  }

  return items.sort(
    (a, b) =>
      b.report.createdAt - a.report.createdAt ||
      (a.report.eventId < b.report.eventId
        ? 1
        : a.report.eventId > b.report.eventId
          ? -1
          : 0),
  );
}

export function useFmgWorkReports() {
  const [events, setEvents] = React.useState<readonly RelayEvent[]>([]);
  const [isLoading, setIsLoading] = React.useState(true);
  const [isFetching, setIsFetching] = React.useState(false);
  const [error, setError] = React.useState<unknown | null>(null);
  const [liveSubscriptionFailed, setLiveSubscriptionFailed] =
    React.useState(false);
  const syncRef = React.useRef<WorkReportEventSync | null>(null);

  React.useEffect(() => {
    const since = Math.max(
      0,
      Math.floor(Date.now() / 1_000) - LIVE_OVERLAP_SECONDS,
    );
    const sync = startWorkReportEventSync({
      liveFilter: {
        kinds: [KIND_WORK_REPORT],
        limit: RECENT_WORK_REPORT_LIMIT,
        since,
        "#t": ["work-report"],
      },
      historyFilter: {
        kinds: [KIND_WORK_REPORT],
        limit: RECENT_WORK_REPORT_LIMIT,
        "#t": ["work-report"],
      },
      maxEvents: RECENT_WORK_REPORT_LIMIT,
      onSnapshot: setEvents,
      onInitialLoadingChange: setIsLoading,
      onFetchingChange: setIsFetching,
      onHistoryError: setError,
      onLiveSubscriptionFailed: setLiveSubscriptionFailed,
    });
    syncRef.current = sync;

    return () => {
      if (syncRef.current === sync) syncRef.current = null;
      sync.dispose();
    };
  }, []);

  const items = React.useMemo(() => latestReports(events), [events]);
  const refetch = React.useCallback(
    () => syncRef.current?.refresh() ?? Promise.resolve(),
    [],
  );

  return {
    data: items,
    items,
    error,
    isError: error !== null,
    isFetching,
    isLoading,
    isPending: isLoading,
    liveSubscriptionFailed,
    refetch,
  };
}

export type UseFmgWorkReportsResult = ReturnType<typeof useFmgWorkReports>;
