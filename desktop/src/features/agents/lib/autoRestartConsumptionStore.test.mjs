import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { register } from "node:module";

import { JSDOM } from "jsdom";

register("./autoRestartConsumptionStore.test-loader.mjs", import.meta.url);

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost",
});

before(() => {
  Object.assign(globalThis, {
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
    localStorage: dom.window.localStorage,
    window: dom.window,
  });
});

after(() => dom.window.close());

test("consumption survives a fresh store, stays scope-isolated, and prunes removed agents", async () => {
  const { AutoRestartConsumptionStore } = await import(
    "./autoRestartConsumptionStore.ts"
  );
  localStorage.clear();
  const scope = `wss://tenant.example\n${"b".repeat(64)}`;
  const agentA = "a".repeat(64);
  const agentB = "c".repeat(64);
  const first = new AutoRestartConsumptionStore(() => localStorage);

  assert.equal(await first.consume(scope, agentA, "generation-1"), "consumed");
  assert.equal(await first.consume(scope, agentB, "generation-2"), "consumed");
  const serialized = localStorage.getItem("buzz:auto-restart-consumptions:v1");
  assert.ok(serialized);
  assert.ok(!serialized.includes("tenant.example"));
  assert.ok(!serialized.includes(agentA));

  // A new instance models a renderer/app restart: it has no in-memory state
  // and must recover the same consumed generation from localStorage.
  const afterRestart = new AutoRestartConsumptionStore(() => localStorage);
  assert.equal(await afterRestart.generation(scope, agentA), "generation-1");
  assert.equal(
    await afterRestart.consume(scope, agentA, "generation-1"),
    "already-consumed",
  );

  await afterRestart.pruneScope(scope, [agentA]);
  const afterPrune = new AutoRestartConsumptionStore(() => localStorage);
  assert.equal(await afterPrune.generation(scope, agentA), "generation-1");
  assert.equal(await afterPrune.generation(scope, agentB), null);
});

test("policy does not replay a consumed running drift after app restart but a new process generation can fire", async () => {
  const { act, cleanup, renderHook } = await import("@testing-library/react");
  const React = await import("react");
  const { QueryClient, QueryClientProvider } = await import(
    "@tanstack/react-query"
  );
  const {
    autoRestartGeneration,
    getAutoRestartFailureScope,
    useAutoRestartPolicy,
  } = await import("./useAutoRestartPolicy.ts");
  const { AutoRestartConsumptionStore, clearConsumedAutoRestartGeneration } =
    await import("./autoRestartConsumptionStore.ts");

  localStorage.clear();
  const originalNow = Date.now;
  let now = 1_000_000;
  Date.now = () => now;
  const relayUrl = "wss://restart.example";
  const signer = "d".repeat(64);
  const pubkey = "e".repeat(64);
  const agent = {
    pubkey,
    needsRestart: true,
    autoRestartOnConfigChange: true,
    backend: { type: "local" },
    status: "running",
    lastStartedAt: "2026-09-28T00:00:00Z",
    pid: 41,
  };
  const failureScope = getAutoRestartFailureScope(relayUrl, signer);
  assert.ok(failureScope);
  const priorRenderer = new AutoRestartConsumptionStore(() => localStorage);
  assert.equal(
    await priorRenderer.consume(
      failureScope,
      pubkey,
      autoRestartGeneration(agent),
    ),
    "consumed",
  );

  let stopCount = 0;
  let startCount = 0;
  globalThis.__restartTest = {
    agents: [agent],
    relayUrl,
    failureCount: 0,
    stopManagedAgent: async () => {
      stopCount += 1;
    },
    startManagedAgent: async () => {
      startCount += 1;
    },
  };
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  const wrapper = ({ children }) =>
    React.createElement(QueryClientProvider, { client: queryClient }, children);
  const hook = renderHook(() => useAutoRestartPolicy(relayUrl, signer), {
    wrapper,
  });
  const flush = async (turns = 5) => {
    for (let i = 0; i < turns; i += 1) {
      await act(async () => {
        await new Promise((resolve) => setImmediate(resolve));
      });
    }
  };

  try {
    await flush();
    now += 3 * 60 * 1_000 + 1;
    hook.rerender();
    await flush();
    assert.equal(stopCount, 0, "same generation must remain consumed");
    assert.equal(startCount, 0, "same generation must not restart again");

    agent.lastStartedAt = "2026-09-28T01:00:00Z";
    agent.pid = 42;
    hook.rerender();
    await flush(8);
    now += 3 * 60 * 1_000 + 1;
    hook.rerender();
    await flush(8);
    assert.equal(stopCount, 1, "new process generation gets one attempt");
    assert.equal(startCount, 1, "new process generation restarts once");
    assert.equal(globalThis.__restartTest.failureCount, 0);
  } finally {
    hook.unmount();
    cleanup();
    queryClient.clear();
    Date.now = originalNow;
    await clearConsumedAutoRestartGeneration(failureScope, pubkey);
    delete globalThis.__restartTest;
  }
});
