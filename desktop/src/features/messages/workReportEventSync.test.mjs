import assert from "node:assert/strict";
import { after, afterEach, before, mock, test } from "node:test";

import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost",
});

before(() => {
  Object.assign(globalThis, {
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
    window: dom.window,
  });
});

afterEach(async () => {
  mock.restoreAll();
  const { cleanup } = await import("@testing-library/react");
  cleanup();
});

after(() => dom.window.close());

const CHANNEL = "4d1413c0-24f3-4df6-9838-9de4373feb1e";
const ROOT = "a".repeat(64);

function reportEvent({
  id,
  createdAt,
  status = "completed",
  outcome = id,
} = {}) {
  return {
    id,
    pubkey: "c".repeat(64),
    created_at: createdAt,
    kind: 40009,
    tags: [
      ["h", CHANNEL],
      ["e", ROOT, "", "root"],
      ["t", "work-report"],
      ["status", status],
    ],
    content: JSON.stringify({ status, outcome }),
    sig: "d".repeat(128),
  };
}

async function waitFor(predicate, message) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(message);
}

test("production sync seam subscribes before overlapping history, dedupes IDs, and repairs reconnect", async () => {
  const { startWorkReportEventSync } = await import("./workReportEventSync.ts");
  const overlap = reportEvent({ id: "1".repeat(64), createdAt: 10 });
  const liveOnly = reportEvent({ id: "2".repeat(64), createdAt: 11 });
  const historyOnly = reportEvent({ id: "3".repeat(64), createdAt: 9 });
  const reconnected = reportEvent({ id: "4".repeat(64), createdAt: 12 });
  const callOrder = [];
  const snapshots = [];
  let liveListener;
  let reconnectListener;
  let fetchCount = 0;
  const transport = {
    subscribeLive: async (filter, listener) => {
      callOrder.push("subscribe");
      assert.equal(filter.limit, 10, "live overlap must stay bounded");
      liveListener = listener;
      return async () => {};
    },
    fetchEvents: async () => {
      fetchCount += 1;
      callOrder.push(`fetch:${fetchCount}`);
      if (fetchCount === 1) {
        // Both events arrive after live registration while history is in
        // flight; overlap is also returned by history.
        liveListener(overlap);
        liveListener(liveOnly);
        return [historyOnly, overlap];
      }
      // Model the restored live REQ racing the reconnect backfill with the
      // same event. The event-id map must publish it once.
      liveListener(reconnected);
      return [overlap, reconnected];
    },
    subscribeToReconnects: (listener) => {
      reconnectListener = listener;
      return () => {};
    },
  };
  const sync = startWorkReportEventSync({
    liveFilter: { kinds: [40009], limit: 10, since: 5 },
    historyFilter: { kinds: [40009], limit: 10 },
    maxEvents: 10,
    onSnapshot: (events) => snapshots.push(events),
    onInitialLoadingChange: () => {},
    onFetchingChange: () => {},
    onHistoryError: (error) => assert.equal(error, null),
    onLiveSubscriptionFailed: () => {},
    transport,
  });

  try {
    await waitFor(() => snapshots.length > 0, "initial snapshot never arrived");
    assert.deepEqual(callOrder.slice(0, 2), ["subscribe", "fetch:1"]);
    const initialIds = snapshots.at(-1).map((event) => event.id);
    assert.equal(initialIds.length, 3);
    assert.equal(new Set(initialIds).size, 3, "overlap delivered once");

    const snapshotCount = snapshots.length;
    liveListener(overlap);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      snapshots.length,
      snapshotCount,
      "duplicate live replay must not republish unchanged state",
    );

    reconnectListener();
    await waitFor(() => fetchCount === 2, "reconnect backfill never ran");
    const reconnectIds = snapshots.at(-1).map((event) => event.id);
    assert.equal(reconnectIds.filter((id) => id === reconnected.id).length, 1);
    assert.ok(reconnectIds.includes(historyOnly.id));
  } finally {
    sync.dispose();
  }
});

test("reconnect queues a fresh overlap backfill when the previous history request is still in flight", async () => {
  const { startWorkReportEventSync } = await import("./workReportEventSync.ts");
  let reconnectListener;
  let finishFirstFetch;
  let fetchCount = 0;
  const firstFetch = new Promise((resolve) => {
    finishFirstFetch = resolve;
  });
  const sync = startWorkReportEventSync({
    liveFilter: { kinds: [40009], limit: 10, since: 5 },
    historyFilter: { kinds: [40009], limit: 10 },
    maxEvents: 10,
    onSnapshot: () => {},
    onInitialLoadingChange: () => {},
    onFetchingChange: () => {},
    onHistoryError: () => {},
    onLiveSubscriptionFailed: () => {},
    transport: {
      subscribeLive: async () => async () => {},
      fetchEvents: () => {
        fetchCount += 1;
        return fetchCount === 1 ? firstFetch : Promise.resolve([]);
      },
      subscribeToReconnects: (listener) => {
        reconnectListener = listener;
        return () => {};
      },
    },
  });

  try {
    await waitFor(() => fetchCount === 1, "initial history did not start");
    reconnectListener();
    finishFirstFetch([]);
    await waitFor(
      () => fetchCount === 2,
      "reconnect was coalesced into the stale in-flight history request",
    );
  } finally {
    sync.dispose();
  }
});

test("FMG and thread hooks both bind the subscribe-first production seam", async () => {
  const {
    act,
    renderHook,
    waitFor: waitForHook,
  } = await import("@testing-library/react");
  const { relayClient } = await import("@/shared/api/relayClient");
  const { useFmgWorkReports } = await import(
    "@/features/fmg/useFmgWorkReports"
  );
  const { useWorkReport } = await import("./useWorkReport.ts");
  const callOrder = [];
  const subscriptions = [];
  const reconnectListeners = new Set();
  let threadFetchCount = 0;

  mock.method(relayClient, "subscribeLive", async (filter, listener) => {
    const kind = filter["#h"] ? "thread" : "fmg";
    callOrder.push(`${kind}:subscribe`);
    subscriptions.push({ filter, kind, listener });
    return async () => {};
  });
  mock.method(relayClient, "subscribeToReconnects", (listener) => {
    reconnectListeners.add(listener);
    return () => reconnectListeners.delete(listener);
  });
  mock.method(relayClient, "fetchEvents", async (filter) => {
    const kind = filter["#h"] ? "thread" : "fmg";
    callOrder.push(`${kind}:fetch`);
    const subscription = subscriptions.find((entry) => entry.kind === kind);
    assert.ok(subscription, `${kind} history ran before live registration`);
    if (kind === "fmg") {
      const event = reportEvent({ id: "5".repeat(64), createdAt: 20 });
      subscription.listener(event);
      return [event];
    }
    threadFetchCount += 1;
    const event = reportEvent({
      id: (threadFetchCount === 1 ? "6" : "7").repeat(64),
      createdAt: 20 + threadFetchCount,
      outcome: `thread-${threadFetchCount}`,
    });
    subscription.listener(event);
    return [event];
  });

  const fmg = renderHook(() => useFmgWorkReports());
  await waitForHook(() => assert.equal(fmg.result.current.isLoading, false));
  assert.deepEqual(callOrder.slice(0, 2), ["fmg:subscribe", "fmg:fetch"]);
  assert.equal(subscriptions[0].filter.limit, 200);
  assert.equal(typeof subscriptions[0].filter.since, "number");
  assert.equal(fmg.result.current.items.length, 1);
  fmg.unmount();

  callOrder.length = 0;
  subscriptions.length = 0;
  const thread = renderHook(() => useWorkReport(CHANNEL, ROOT));
  await waitForHook(() => assert.equal(thread.result.current.isPending, false));
  assert.deepEqual(callOrder.slice(0, 2), ["thread:subscribe", "thread:fetch"]);
  assert.equal(subscriptions[0].filter.limit, 100);
  assert.equal(thread.result.current.data?.eventId, "6".repeat(64));

  await act(async () => {
    for (const listener of reconnectListeners) listener();
    await new Promise((resolve) => setImmediate(resolve));
  });
  await waitForHook(() =>
    assert.equal(thread.result.current.data?.eventId, "7".repeat(64)),
  );
  assert.equal(threadFetchCount, 2, "reconnect triggers one overlap backfill");
  thread.unmount();
});
