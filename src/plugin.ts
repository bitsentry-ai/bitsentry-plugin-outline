import type {
  DesktopCodePlugin as SdkCodePlugin,
  DesktopCodePluginAction,
  DesktopPluginCodeActionContext as SdkActionContext,
  DesktopPluginFieldDefinition,
} from "@bitsentry/plugin-sdk";

// Additive persistence contract while the new SDK release is pending. New hosts
// validate this descriptor and handlers against their canonical SDK schemas.
type DesktopCodePlugin = Omit<SdkCodePlugin, "metadata"> & {
  metadata: SdkCodePlugin["metadata"] & { persistence: {
    configVersion: number; destinationField: string;
    configFields: DesktopPluginFieldDefinition[];
    resources: Array<{ type: string; stateVersion: number; readActionId: string }>;
    eventChannels: string[];
  } };
  persistence: {
    validateConfig(config: Record<string, unknown>): Record<string, unknown>;
    validateResourceState(input: { resourceType: string; version: number; state: unknown }): unknown;
  };
};

// SDK 0.1.0 predates the optional operation context supplied by newer hosts.
// Keep the standalone package compatible with both host generations.
type DesktopPluginCodeActionContext = SdkActionContext & {
  config?: Record<string, unknown>;
  operation?: {
    signal?: AbortSignal;
    deadlineAt?: number;
    executionId?: string;
  };
};

const DEFAULT_API_BASE = "https://app.getoutline.com/api";

function stringValue(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
}

function apiBase(value: unknown): string {
  const url = new URL(stringValue(value, "apiBase").trim());
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("apiBase must be an HTTPS URL without credentials, query, or fragment");
  }
  let normalized = url.href;
  while (normalized.endsWith("/")) normalized = normalized.slice(0, -1);
  return normalized;
}

function authorizedBase(value: unknown): string {
  const base = apiBase(value ?? DEFAULT_API_BASE);
  const allowed = (process.env.OUTLINE_ALLOWED_API_BASES ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map(apiBase);
  if (base !== DEFAULT_API_BASE && !allowed.includes(base)) {
    throw new Error("Self-hosted Outline requires its exact API URL in OUTLINE_ALLOWED_API_BASES on the host");
  }
  return base;
}

function integer(value: unknown, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`Pagination must use integers between ${String(min)} and ${String(max)}`);
  }
  return value;
}

function parameters(context: DesktopPluginCodeActionContext, method: string): Record<string, unknown> {
  const { input } = context;
  if (method === "documents.info") return { id: stringValue(input.id, "id").trim() };
  if (method === "documents.delete") return deleteParameters(input);
  if (method === "documents.update") return updateParameters(input);
  if (method === "documents.create") {
    const title = stringValue(input.title, "title");
    const text = stringValue(input.text, "text");
    if (title.length > 100 || text.length > 1_536_000) {
      throw new Error("Outline limits titles to 100 characters and document text to 1536000 characters");
    }
    if (input.publish !== undefined && typeof input.publish !== "boolean") {
      throw new Error("publish must be a boolean");
    }
    const body: Record<string, unknown> = {
      title, text, publish: input.publish ?? false,
      collectionId: stringValue(input.collectionId, "collectionId").trim(),
    };
    if (input.parentDocumentId !== undefined) {
      body.parentDocumentId = stringValue(input.parentDocumentId, "parentDocumentId").trim();
    }
    return body;
  }
  const body: Record<string, unknown> = {
    limit: integer(input.limit, 25, 1, 100),
    offset: integer(input.offset, 0, 0, Number.MAX_SAFE_INTEGER),
  };
  if (method === "documents.search") body.query = stringValue(input.query, "query");
  if (method !== "collections.list" && input.collectionId !== undefined) {
    body.collectionId = stringValue(input.collectionId, "collectionId").trim();
  }
  return body;
}

function deleteParameters(input: Record<string, unknown>): Record<string, unknown> {
  if (input.confirmDelete !== true) throw new Error("confirmDelete must be true to delete a document");
  return { id: stringValue(input.id, "id").trim(), permanent: false };
}

function updateParameters(input: Record<string, unknown>): Record<string, unknown> {
  const body: Record<string, unknown> = { id: stringValue(input.id, "id").trim() };
  if (input.title !== undefined) {
    body.title = stringValue(input.title, "title");
    if ((body.title as string).length > 100) throw new Error("title exceeds 100 characters");
  }
  if (input.text !== undefined) {
    if (typeof input.text !== "string" || input.text.length > 1_536_000) throw new Error("text must be Markdown up to 1536000 characters");
    body.text = input.text;
    const mode = input.editMode ?? "replace";
    if (mode !== "replace" && mode !== "append" && mode !== "prepend") throw new Error("editMode must be replace, append, or prepend");
    body.editMode = mode;
  }
  if (input.publish !== undefined) {
    if (typeof input.publish !== "boolean") throw new Error("publish must be a boolean");
    body.publish = input.publish;
  }
  if (Object.keys(body).length === 1) throw new Error("Provide title, text, or publish to update");
  if (input.lastRevision !== undefined) body.lastRevision = integer(input.lastRevision, 0, 0, Number.MAX_SAFE_INTEGER);
  return body;
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Outline returned an invalid JSON response");
  }
  return value as Record<string, unknown>;
}

async function request(context: DesktopPluginCodeActionContext, method: string) {
  const base = authorizedBase(context.config?.endpoint ?? context.auth.apiBase);
  const token = stringValue(context.auth.accessToken, "accessToken").trim();
  const body = parameters(context, method);
  const deadline = context.operation?.deadlineAt ?? Date.now() + 30_000;
  const remaining = Math.min(30_000, deadline - Date.now());
  if (!Number.isFinite(remaining) || remaining <= 0) throw new Error("Outline operation deadline exceeded");
  const signals = [AbortSignal.timeout(Math.ceil(remaining))];
  if (context.operation?.signal) signals.push(context.operation.signal);
  const response = await fetch(`${base}/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.any(signals),
    redirect: "error",
  });
  if (!response.ok) {
    // Do not echo server response text: it may contain credentials or document content.
    const retryAfter = response.headers.get("retry-after");
    return {
      ok: false,
      status: response.status,
      summary: `Outline ${method} failed (HTTP ${String(response.status)})`,
      data: response.status === 429 ? { retryAfter } : undefined,
    };
  }
  const payload = record(await response.json());
  if (payload.ok === false || payload.success === false) {
    return { ok: false, status: 502, summary: `Outline ${method} reported an API error` };
  }
  if (method === "documents.delete") {
    if (payload.success !== true) throw new Error("Outline did not confirm document deletion");
    return { ok: true, status: response.status, summary: "Outline document moved to trash", data: { id: body.id, deleted: true } };
  }
  if (!("data" in payload)) throw new Error("Outline response is missing data");
  return {
    ok: true,
    status: response.status,
    summary: `Outline ${method} succeeded`,
    data: { data: payload.data, pagination: payload.pagination ?? null },
  };
}

function field(key: string, label: string, required = false): DesktopPluginFieldDefinition {
  return { key, label, type: "string", required };
}

const pagination: DesktopPluginFieldDefinition[] = [
  { key: "limit", label: "Page size (1–100)", type: "number", required: false, defaultValue: 25 },
  { key: "offset", label: "Offset", type: "number", required: false, defaultValue: 0 },
];

function action(
  id: string,
  title: string,
  method: string,
  fields: DesktopPluginFieldDefinition[],
  riskLevel: "read" | "write" = "read",
): DesktopCodePluginAction {
  return { id, title, description: title, riskLevel, fields, execute: (context) => request(context, method) };
}

export const plugin: DesktopCodePlugin = {
  metadata: { persistence: {
    configVersion: 1,
    destinationField: "endpoint",
    configFields: [
      { key: "endpoint", label: "Instance URL", type: "string", required: true },
    ],
    resources: [{ type: "document", stateVersion: 1, readActionId: "get_document" }],
    eventChannels: [],
  } },
  persistence: {
    validateConfig(config) {
      return { ...config, endpoint: apiBase(config.endpoint) };
    },
    validateResourceState({ state }) {
      if (state === null || typeof state !== "object" || Array.isArray(state)) throw new Error("Resource state must be an object");
      return state;
    },
  },
  id: "outline",
  name: "Outline",
  version: "0.2.2",
  type: "data_source",
  description: "Search Outline knowledge and create, read, update, and delete Markdown documents.",
  auth: {
    fields: [
      { ...field("accessToken", "Outline API key", true), secret: true },
      { ...field("apiBase", "Outline API URL"), defaultValue: DEFAULT_API_BASE },
    ],
  },
  actions: [
    action("list_collections", "List Outline collections", "collections.list", pagination),
    action("list_documents", "List Outline documents", "documents.list", [field("collectionId", "Collection ID"), ...pagination]),
    action("search_documents", "Search Outline documents", "documents.search", [field("query", "Search query", true), field("collectionId", "Collection ID"), ...pagination]),
    action("get_document", "Read an Outline document", "documents.info", [field("id", "Document ID or URL identifier", true)]),
    action("create_document", "Create an Outline document", "documents.create", [
      field("collectionId", "Collection ID", true),
      field("title", "Title", true),
      field("text", "Markdown content", true),
      field("parentDocumentId", "Parent document ID"),
      { key: "publish", label: "Publish to the collection", type: "boolean", required: false, defaultValue: false },
    ], "write"),
    action("update_document", "Update an Outline document", "documents.update", [
      field("id", "Document ID", true), field("title", "New title"), field("text", "Markdown content"),
      { ...field("editMode", "Text edit mode"), enumValues: ["replace", "append", "prepend"], defaultValue: "replace" },
      { key: "lastRevision", label: "Expected revision (prevents overwriting newer edits)", type: "number", required: false },
      { key: "publish", label: "Publish draft", type: "boolean", required: false },
    ], "write"),
    action("delete_document", "Move an Outline document to trash", "documents.delete", [
      field("id", "Document ID", true),
      { key: "confirmDelete", label: "Confirm deletion", type: "boolean", required: true },
    ], "write"),
  ],
};

export default plugin;
