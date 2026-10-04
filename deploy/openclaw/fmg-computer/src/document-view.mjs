import { operatorRequest } from "./task-view.mjs";

export const documentActions = new Set([
  "documents.access",
  "documents.list",
  "documents.get",
  "documents.versions",
  "documents.source",
  "documents.by_request",
  "documents.save",
  "documents.task_source",
]);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const fields = {
  "documents.access": ["taskId"],
  "documents.list": ["cursor"],
  "documents.get": ["taskId", "documentId", "version"],
  "documents.source": ["taskId", "documentId", "version"],
  "documents.versions": ["taskId"],
  "documents.task_source": ["taskId"],
  "documents.by_request": ["taskId", "saveRequestId"],
  "documents.save": [
    "taskId",
    "saveRequestId",
    "documentId",
    "expectedVersion",
    "markdownBase64",
  ],
};
const base = [
  "type",
  "schemaVersion",
  "requestId",
  "relay",
  "expiresAt",
  "action",
];

/** Exact per-operation targets; no caller can choose an OAuth client or audience. */
export function validateDocumentRequest(request) {
  const target = fields[request.action];
  const keys = Object.keys(request);
  if (
    !target ||
    keys.length !== base.length + target.length ||
    keys.some((key) => !base.includes(key) && !target.includes(key))
  )
    throw new Error("invalid_request");
  for (const key of target) {
    const value = request[key];
    if (key === "markdownBase64") {
      if (
        typeof value !== "string" ||
        value.length > 43692 ||
        !/^[A-Za-z0-9+/]*={0,2}$/.test(value)
      )
        throw new Error("invalid_request");
    } else if (key === "version" || key === "expectedVersion") {
      if (
        !(key === "version" && value === null) &&
        (!Number.isInteger(value) ||
          value < (key === "version" ? 1 : 0) ||
          value > 20)
      )
        throw new Error("invalid_request");
    } else if (
      !(value === null && (key === "documentId" || key === "cursor")) &&
      !uuid.test(value)
    )
      throw new Error("invalid_request");
  }
  if (
    ["documents.get", "documents.source"].includes(request.action) &&
    !uuid.test(request.documentId)
  )
    throw new Error("invalid_request");
}

/** Server checks an explicit grant from the original proposing connection. */
export async function documentView(config, binding, request, signal) {
  validateDocumentRequest(request);
  const names = {
    taskId: "task_id",
    documentId: "document_id",
    saveRequestId: "request_id",
    expectedVersion: "expected_version",
    markdownBase64: "markdown_base64",
    version: "version",
    cursor: "cursor",
  };
  const args = Object.fromEntries(
    fields[request.action].map((key) => [names[key], request[key]]),
  );
  return await operatorRequest(config, binding, request.action, args, signal);
}
