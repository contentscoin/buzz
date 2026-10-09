import { z } from "zod";

const status = z.enum([
  "awaiting_approval",
  "approved",
  "dispatching",
  "cancel_requested",
  "needs_reconcile",
  "succeeded",
  "failed",
  "canceled",
  "expired",
]);
export const taskStatusLabel: Record<z.infer<typeof status>, string> = {
  awaiting_approval: "승인 대기",
  approved: "승인됨 · 실행 대기",
  dispatching: "실행 요청됨",
  cancel_requested: "취소 요청됨",
  needs_reconcile: "결과 확인·복구 필요",
  succeeded: "완료",
  failed: "실패",
  canceled: "취소됨",
  expired: "승인 만료",
};
const summary = z.object({
  task_id: z.uuid(),
  status,
  revision: z.number().int().positive(),
  created_at: z.number().finite(),
  updated_at: z.number().finite(),
  role_id: z.string().max(100),
  requested_model: z.string().max(500),
  requested_effort: z.string().max(20).nullable().optional(),
  proposal_hash: z.string().regex(/^[0-9a-f]{64}$/),
});
export const taskListSchema = z.object({
  tasks: z.array(summary).max(25),
  limit: z.literal(25),
});
const projectBinding = z
  .object({
    schema: z.literal(1),
    project_id: z.literal("buzz"),
    repository_url: z.literal("https://github.com/contentscoin/buzz.git"),
    role_id: z.enum([
      "fmg-planner",
      "fmg-frontend",
      "fmg-backend",
      "fmg-qa",
      "fmg-release",
    ]),
    branch: z.string().max(200),
    source_commit: z.string().regex(/^[0-9a-f]{40}$/),
    execution_host: z.literal("hostinger"),
    workspace_binding: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .refine((value) => value.branch === `fmg-buzz/${value.role_id}`, {
    message: "작업 브랜치가 역할과 일치하지 않습니다.",
  });
export const taskDetailSchema = summary
  .omit({ role_id: true, requested_model: true })
  .extend({
    run_id: z.uuid().nullable(),
    dispatch_stage: z.string().max(100).nullable(),
    proposal: z
      .object({
        role_id: z.string().max(100),
        requested_model: z.string().max(500),
        requested_effort: z.string().max(20).nullable().optional(),
        instructions: z.string().max(5000),
        project: projectBinding.optional(),
        proposal_account: z
          .enum(["gateway_owner_main", "original_oauth_client"])
          .optional(),
      })
      .refine(
        (value) => !value.project || value.project.role_id === value.role_id,
        { message: "저장소 작업의 역할이 제안과 일치하지 않습니다." },
      )
      .refine(
        (value) => Boolean(value.project) === Boolean(value.proposal_account),
        { message: "저장소 작업의 제안 계정 결속이 누락됐습니다." },
      ),
    result: z
      .object({
        status,
        reply: z.string().max(30000),
        reply_truncated: z.boolean(),
        requested_model: z.string().max(500).nullable(),
        actual_model: z.string().max(500).nullable(),
        error_code: z.string().max(200).nullable(),
      })
      .nullable(),
    recovery_history: z
      .array(
        z.object({
          revision: z.number().int(),
          previous_status: status,
          recorded_at: z.number().finite(),
        }),
      )
      .max(5),
  });
export type TaskSummary = z.infer<typeof summary>;
export type TaskDetail = z.infer<typeof taskDetailSchema>;
