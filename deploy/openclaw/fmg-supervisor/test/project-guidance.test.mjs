import assert from "node:assert/strict";
import { test } from "node:test";
import { buzzProjectGuidance, guideStart, guideEnd } from "../scripts/buzz-project-guidance.mjs";
const role = "fmg-release", path = `/data/.openclaw/workspaces/${role}/projects/buzz`, branch = `fmg-buzz/${role}`;
const legacy = "# 역할 안내\n작업 저장소: /data/worktrees/fmg-release\n기존 설정\n";
test("Buzz routing precedes legacy repo while retaining all legacy content", () => {
  const updated = buzzProjectGuidance(legacy, role, path, branch);
  assert.equal(updated.startsWith(guideStart), true);
  assert.equal(updated.endsWith(legacy), true);
  assert.ok(updated.includes(`git -C ${path}`));
  assert.ok(updated.includes(`브랜치: ${branch}`));
});
test("existing weak footer becomes one scoped header without duplicating guidance", () => {
  const old = `${legacy}\n${guideStart}\nold rule\n${guideEnd}\n`;
  const next = buzzProjectGuidance(old, role, path, branch);
  assert.equal(next.startsWith(guideStart), true);
  assert.equal(next.includes("old rule"), false);
  assert.equal(next.includes(legacy.trimEnd()), true);
  assert.equal(next.split(guideStart).length, 2);
  assert.equal(buzzProjectGuidance(next, role, path, branch), next);
});
for (const [name, old, r, p, b] of [
  ["foreign role", legacy, "other", path, branch],
  ["foreign path", legacy, role, "/data/worktrees/fmg-release", branch],
  ["foreign branch", legacy, role, path, "agent/release"],
  ["missing end", legacy + guideStart, role, path, branch],
  ["reversed markers", guideEnd + legacy + guideStart, role, path, branch],
  ["duplicate markers", `${guideStart}${guideEnd}${guideStart}${guideEnd}`, role, path, branch],
  ["oversized input", "x".repeat(524289), role, path, branch],
  ["oversized output", "x".repeat(524200), role, path, branch],
]) test(`Buzz guidance refuses ${name}`, () => assert.throws(() => buzzProjectGuidance(old, r, p, b)));
