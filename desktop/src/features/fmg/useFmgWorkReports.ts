import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import {
  reduceWorkReports,
  type WorkReport,
} from "@/features/messages/lib/workReport";
import { relayClient } from "@/shared/api/relayClient";
import type { RelayEvent } from "@/shared/api/types";
import { KIND_WORK_REPORT } from "@/shared/constants/kinds";

const RECENT_WORK_REPORT_LIMIT = 200;
const LIVE_SUBSCRIPTION_MAX_ATTEMPTS = 3;
const LIVE_SUBSCRIPTION_RETRY_DELAY_MS = 3_000;
const FMG_WORK_REPORTS_QUERY_KEY = ["fmg", "work-reports"] as const;

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
  const queryClient = useQueryClient();
  const [liveSubscriptionFailed, setLiveSubscriptionFailed] =
    React.useState(false);
  const query = useQuery({
    queryKey: FMG_WORK_REPORTS_QUERY_KEY,
    queryFn: async () => {
      const events = await relayClient.fetchEvents({
        kinds: [KIND_WORK_REPORT],
        limit: RECENT_WORK_REPORT_LIMIT,
        "#t": ["work-report"],
      });
      return latestReports(events);
    },
    staleTime: 0,
  });

  React.useEffect(() => {
    let disposed = false;
    let unsubscribe: (() => Promise<void>) | null = null;
    let attempts = 0;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const subscribe = () => {
      attempts += 1;
      void relayClient
        .subscribeLive(
          {
            kinds: [KIND_WORK_REPORT],
            limit: 0,
            "#t": ["work-report"],
          },
          () => {
            void queryClient.invalidateQueries({
              queryKey: FMG_WORK_REPORTS_QUERY_KEY,
            });
          },
        )
        .then((dispose) => {
          if (disposed) {
            void dispose();
            return;
          }
          unsubscribe = dispose;
          setLiveSubscriptionFailed(false);
        })
        .catch(() => {
          if (disposed) return;
          if (attempts < LIVE_SUBSCRIPTION_MAX_ATTEMPTS) {
            retryTimer = setTimeout(
              subscribe,
              LIVE_SUBSCRIPTION_RETRY_DELAY_MS * attempts,
            );
            return;
          }
          setLiveSubscriptionFailed(true);
        });
    };

    setLiveSubscriptionFailed(false);
    subscribe();

    return () => {
      disposed = true;
      if (retryTimer) clearTimeout(retryTimer);
      void unsubscribe?.();
    };
  }, [queryClient]);

  return { ...query, items: query.data ?? [], liveSubscriptionFailed };
}

export type UseFmgWorkReportsResult = ReturnType<typeof useFmgWorkReports>;
