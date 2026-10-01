import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { after, afterEach, before, test } from "node:test";
import { JSDOM } from "jsdom";
import * as React from "react";
import * as query from "@tanstack/react-query";
import ts from "typescript";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost",
});
before(() =>
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
  }),
);
afterEach(async () => (await import("@testing-library/react")).cleanup());
after(() => dom.window.close());

function load(file, api) {
  const exports = {};
  const element =
    (tag) =>
    ({ children, ...props }) =>
      React.createElement(tag, props, children);
  const stubs = {
    react: React,
    "@tanstack/react-query": query,
    "@/shared/api/tauriFmg": api,
    "@/shared/api/tauriIdentity": {
      getIdentity: async () => ({ pubkey: "c".repeat(64) }),
    },
    "@/shared/ui/button": {
      Button: ({ variant, size, ...props }) =>
        React.createElement("button", { type: "button", ...props }),
    },
    "@/shared/ui/input": { Input: element("input") },
    "@/shared/ui/textarea": { Textarea: element("textarea") },
    "@/features/settings/ui/SettingsOptionGroup": {
      SettingsOptionGroup: ({ children }) => children,
    },
    "@/shared/ui/dialog": {
      Dialog: ({ children }) => children,
      DialogContent: ({ children }) => children,
      DialogHeader: element("header"),
      DialogTitle: element("h2"),
      DialogDescription: element("p"),
    },
  };
  vm.runInNewContext(
    ts.transpileModule(
      fs.readFileSync(new URL(file, import.meta.url), "utf8"),
      {
        compilerOptions: {
          module: ts.ModuleKind.CommonJS,
          target: ts.ScriptTarget.ES2022,
          jsx: ts.JsxEmit.React,
        },
      },
    ).outputText,
    {
      exports,
      require: (name) => {
        assert.ok(name in stubs, `unmocked dependency: ${name}`);
        return stubs[name];
      },
    },
  );
  return exports;
}

async function mount(Component, props = {}) {
  const ui = await import("@testing-library/react");
  const client = new query.QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const view = ui.render(
    React.createElement(
      query.QueryClientProvider,
      { client },
      React.createElement(Component, props),
    ),
  );
  return { ...ui, ...view, client };
}

test("Aside save preserves errors and persists one explicit disabled setting before confirming", async () => {
  const calls = [];
  let fail = true;
  const { FmgBrowserSettingsCard } = load("./FmgBrowserSettingsCard.tsx", {
    getFmgBrowserConfig: async () => ({ mode: "environment", command: "" }),
    setFmgBrowserConfig: async (config) => {
      calls.push(config);
      if (fail) throw new Error("storage unavailable");
    },
  });
  const ui = await mount(FmgBrowserSettingsCard);
  await ui.findByText("브라우저 설정 저장");
  ui.fireEvent.change(ui.getByLabelText("연결 방식"), {
    target: { value: "disabled" },
  });
  ui.fireEvent.click(ui.getByText("브라우저 설정 저장"));
  assert.match(
    (await ui.findByRole("alert")).textContent,
    /storage unavailable/,
  );
  assert.ok(ui.queryByText(/저장했습니다/) === null);
  assert.equal(ui.getByLabelText("연결 방식").value, "disabled");
  fail = false;
  ui.fireEvent.click(ui.getByText("브라우저 설정 저장"));
  await ui.findByText(/저장했습니다/);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].mode, "disabled");
  assert.equal(calls[1].command, "");
  assert.equal(
    ui.client.getQueryData(["fmg", "browser-config"]).mode,
    "disabled",
  );
  ui.client.clear();
});

test("transition carries reviewed head and scope, forbids retry after failure, then refreshes", async () => {
  const calls = [];
  let head = "a".repeat(64);
  let fail = true;
  let accepted = 0;
  const { FmgGraphTransitionDialog } = load("./FmgGraphTransitionDialog.tsx", {
    getFmgGraphContext: async (task) => {
      assert.equal(task.signerPubkey, "c".repeat(64));
      return { state: "pending", head };
    },
    transitionFmgGraphTask: async (transition) => {
      calls.push(transition);
      if (fail) throw new Error("head changed");
      return { accepted: true, event_id: "d".repeat(64) };
    },
  });
  const ui = await mount(FmgGraphTransitionDialog, {
    item: {
      issueId: "e".repeat(64),
      repositoryId: "repo-key",
      repositoryOwner: "b".repeat(64),
      repositoryDtag: "repo",
      title: "Task",
      projectName: "Project",
    },
    relayUrl: "wss://community.example",
    onClose: () => {},
    onAccepted: () => {
      accepted += 1;
    },
  });
  await ui.findByLabelText("다음 그래프 상태");
  assert.equal(ui.getByLabelText("현재 그래프 상태").readOnly, true);
  ui.fireEvent.change(ui.getByLabelText("다음 그래프 상태"), {
    target: { value: "in-progress" },
  });
  ui.fireEvent.change(ui.getByLabelText("전환 사유·근거"), {
    target: { value: "작업 시작" },
  });
  ui.fireEvent.click(ui.getByText("검증 후 상태 전환"));
  await ui.findByText("Error: head changed");
  assert.equal(ui.getByText("검증 후 상태 전환").disabled, true);
  ui.fireEvent.click(ui.getByText("검증 후 상태 전환"));
  assert.equal(calls.length, 1);
  assert.equal(accepted, 0);
  assert.equal(calls[0].expectedHead, head);
  assert.equal(calls[0].task.relayUrl, "wss://community.example");
  head = "f".repeat(64);
  fail = false;
  ui.fireEvent.click(ui.getByText("이력 새로 확인"));
  await ui.waitFor(() =>
    assert.ok(ui.queryByText("Error: head changed") === null),
  );
  await ui.findByLabelText("다음 그래프 상태");
  ui.fireEvent.change(ui.getByLabelText("다음 그래프 상태"), {
    target: { value: "in-progress" },
  });
  ui.fireEvent.change(ui.getByLabelText("전환 사유·근거"), {
    target: { value: "재확인 후 시작" },
  });
  ui.fireEvent.click(ui.getByText("검증 후 상태 전환"));
  await ui.findByText(/릴레이가 전환을 승인했습니다/);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].expectedHead, head);
  assert.equal(accepted, 1);
  ui.client.clear();
});
