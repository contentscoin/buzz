import { relayClient } from "@/shared/api/relayClient";
import type { RelaySubscriptionFilter } from "@/shared/api/relayClientShared";
import type { RelayEvent } from "@/shared/api/types";

const DEFAULT_MAX_SUBSCRIBE_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 3_000;

type WorkReportSyncTransport = {
  subscribeLive: (
    filter: RelaySubscriptionFilter,
    onEvent: (event: RelayEvent) => void,
    signal?: AbortSignal,
  ) => Promise<() => Promise<void>>;
  fetchEvents: (filter: RelaySubscriptionFilter) => Promise<RelayEvent[]>;
  subscribeToReconnects: (listener: () => void) => () => void;
};

export type WorkReportEventSyncOptions = {
  liveFilter: RelaySubscriptionFilter;
  historyFilter: RelaySubscriptionFilter;
  maxEvents: number;
  onSnapshot: (events: readonly RelayEvent[]) => void;
  onInitialLoadingChange: (loading: boolean) => void;
  onFetchingChange: (fetching: boolean) => void;
  onHistoryError: (error: unknown | null) => void;
  onLiveSubscriptionFailed: (failed: boolean) => void;
  transport?: WorkReportSyncTransport;
  maxSubscribeAttempts?: number;
  retryDelayMs?: number;
  setTimeoutFn?: (
    callback: () => void,
    delayMs: number,
  ) => ReturnType<typeof setTimeout>;
  clearTimeoutFn?: (timer: ReturnType<typeof setTimeout>) => void;
};

export type WorkReportEventSync = {
  refresh: () => Promise<void>;
  dispose: () => void;
};

function newestFirst(left: RelayEvent, right: RelayEvent) {
  return (
    right.created_at - left.created_at ||
    (left.id < right.id ? 1 : left.id > right.id ? -1 : 0)
  );
}

/**
 * Own one lossless work-report feed.
 *
 * Registration always precedes history. The bounded live replay and explicit
 * history fetch intentionally overlap, and one event-id map owns both paths.
 * The same map stays alive across RelayClient reconnect replay, while a
 * reconnect-triggered backfill repairs the bounded window again.
 */
export function startWorkReportEventSync(
  options: WorkReportEventSyncOptions,
): WorkReportEventSync {
  const transport = options.transport ?? {
    subscribeLive: (filter, onEvent, signal) =>
      relayClient.subscribeLive(filter, onEvent, undefined, undefined, signal),
    fetchEvents: (filter) => relayClient.fetchEvents(filter),
    subscribeToReconnects: (listener) =>
      relayClient.subscribeToReconnects(listener),
  };
  const maxSubscribeAttempts =
    options.maxSubscribeAttempts ?? DEFAULT_MAX_SUBSCRIBE_ATTEMPTS;
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const setTimeoutFn = options.setTimeoutFn ?? setTimeout;
  const clearTimeoutFn = options.clearTimeoutFn ?? clearTimeout;
  const subscriptionAbort = new AbortController();
  const events = new Map<string, RelayEvent>();
  let disposed = false;
  let hydrated = false;
  let unsubscribe: (() => Promise<void>) | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let historyPromise: Promise<void> | null = null;
  let refreshQueued = false;
  let subscribeAttempts = 0;
  let settleInitial = () => {};
  const initial = new Promise<void>((resolve) => {
    settleInitial = resolve;
  });

  const snapshot = () => [...events.values()].sort(newestFirst);
  const merge = (incoming: readonly RelayEvent[]) => {
    let changed = false;
    for (const event of incoming) {
      if (events.has(event.id)) continue;
      events.set(event.id, event);
      changed = true;
    }
    if (events.size > options.maxEvents) {
      const retained = snapshot().slice(0, options.maxEvents);
      events.clear();
      for (const event of retained) events.set(event.id, event);
    }
    if (changed && hydrated && !disposed) options.onSnapshot(snapshot());
  };

  const onLiveEvent = (event: RelayEvent) => merge([event]);

  const refreshHistory = () => {
    if (disposed) return Promise.resolve();
    if (historyPromise) return historyPromise;
    options.onFetchingChange(true);
    historyPromise = transport
      .fetchEvents(options.historyFilter)
      .then((history) => {
        if (disposed) return;
        merge(history);
        hydrated = true;
        options.onHistoryError(null);
        options.onSnapshot(snapshot());
      })
      .catch((error) => {
        if (disposed) return;
        hydrated = true;
        options.onHistoryError(error);
        options.onSnapshot(snapshot());
        throw error;
      })
      .finally(() => {
        if (!disposed) {
          options.onFetchingChange(false);
          options.onInitialLoadingChange(false);
        }
        settleInitial();
        historyPromise = null;
      });
    return historyPromise;
  };

  const queueHistoryRefresh = async () => {
    if (historyPromise) {
      refreshQueued = true;
      await historyPromise.catch(() => {});
      if (disposed || !refreshQueued) return;
      refreshQueued = false;
    }
    await refreshHistory().catch(() => {});
  };

  const subscribeAndBackfill = async (): Promise<void> => {
    if (disposed) return;
    subscribeAttempts += 1;
    try {
      const disposeSubscription = await transport.subscribeLive(
        options.liveFilter,
        onLiveEvent,
        subscriptionAbort.signal,
      );
      if (disposed) {
        void disposeSubscription().catch(() => {});
        return;
      }
      unsubscribe = disposeSubscription;
      options.onLiveSubscriptionFailed(false);
      await refreshHistory().catch(() => {});
    } catch {
      if (disposed) return;
      // History remains useful while live registration is unavailable. A
      // later successful retry subscribes first and backfills again, covering
      // the interval between attempts.
      await refreshHistory().catch(() => {});
      if (subscribeAttempts >= maxSubscribeAttempts) {
        options.onLiveSubscriptionFailed(true);
        return;
      }
      retryTimer = setTimeoutFn(() => {
        retryTimer = null;
        void subscribeAndBackfill();
      }, retryDelayMs * subscribeAttempts);
    }
  };

  options.onInitialLoadingChange(true);
  options.onLiveSubscriptionFailed(false);
  const unsubscribeReconnects = transport.subscribeToReconnects(() => {
    // RelayClient restores the live REQ before notifying reconnect listeners.
    // This fetch therefore overlaps the restored stream just like startup.
    void queueHistoryRefresh();
  });
  void subscribeAndBackfill();

  return {
    refresh: async () => {
      // A user refresh during startup must not invert subscribe-first order.
      await initial;
      await queueHistoryRefresh();
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      settleInitial();
      subscriptionAbort.abort();
      if (retryTimer !== null) clearTimeoutFn(retryTimer);
      unsubscribeReconnects();
      if (unsubscribe) void unsubscribe().catch(() => {});
    },
  };
}
