import { performance } from "node:perf_hooks";
import type { ChatMessage, ModelUsage } from "./openrouter.js";

export type DirectJudgeProvider = "minimax" | "deepseek";

export interface DirectJudgeSpec {
  id: string;
  provider: DirectJudgeProvider;
  model: string;
  baseUrl: string;
  apiKeyEnv: string;
  temperature: number;
  topP?: number;
  maxTokens: number;
  thinking: string;
}

export interface DirectJudgeResponse {
  id: string;
  provider: DirectJudgeProvider;
  model: string;
  content: string;
  latencyMs: number;
  usage: ModelUsage & { cachedPromptTokens?: number; reasoningTokens?: number };
}

export interface DirectJudgeRequest {
  spec: DirectJudgeSpec;
  apiKey: string;
  messages: ChatMessage[];
}

class JudgeHttpError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message);
  }
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => part && typeof part === "object" && "text" in part ? String(part.text) : "")
    .join("");
}

function requestBody(request: DirectJudgeRequest): Record<string, unknown> {
  const common = {
    model: request.spec.model,
    messages: request.messages,
    temperature: request.spec.temperature,
  };
  if (request.spec.provider === "minimax") {
    return {
      ...common,
      top_p: request.spec.topP ?? 0.95,
      max_completion_tokens: request.spec.maxTokens,
      reasoning_split: true,
      ...(request.spec.thinking === "disabled" ? { thinking: { type: "disabled" } } : {}),
    };
  }
  return {
    ...common,
    max_tokens: request.spec.maxTokens,
    thinking: { type: "disabled" },
    response_format: { type: "json_object" },
  };
}

export async function callDirectJudge(request: DirectJudgeRequest): Promise<DirectJudgeResponse> {
  const startedAt = performance.now();
  const endpoint = `${request.spec.baseUrl.replace(/\/$/, "")}/chat/completions`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${request.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(requestBody(request)),
    signal: AbortSignal.timeout(120_000),
  });
  const body = await response.text();
  if (!response.ok) {
    const retryable = response.status === 408 || response.status === 409
      || response.status === 429 || response.status >= 500;
    throw new JudgeHttpError(
      `${request.spec.provider} HTTP ${response.status}: ${body.slice(0, 500)}`,
      retryable,
    );
  }
  const parsed = JSON.parse(body) as {
    id?: string;
    model?: string;
    choices?: Array<{ message?: { content?: unknown } }>;
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      total_tokens?: number;
      prompt_cache_hit_tokens?: number;
      prompt_tokens_details?: { cached_tokens?: number };
      completion_tokens_details?: { reasoning_tokens?: number };
    };
    base_resp?: { status_code?: number; status_msg?: string };
  };
  if (typeof parsed.base_resp?.status_code === "number" && parsed.base_resp.status_code !== 0) {
    throw new JudgeHttpError(
      `${request.spec.provider} API ${parsed.base_resp.status_code}: ${parsed.base_resp.status_msg ?? "unknown error"}`,
      true,
    );
  }
  const content = contentText(parsed.choices?.[0]?.message?.content).trim();
  if (!content) throw new JudgeHttpError(`${request.spec.provider} returned an empty response`, true);
  const returnedModel = parsed.model ?? request.spec.model;
  if (returnedModel !== request.spec.model) {
    throw new JudgeHttpError(
      `${request.spec.provider} returned model ${returnedModel}, expected ${request.spec.model}`,
      false,
    );
  }
  const cachedPromptTokens = parsed.usage?.prompt_cache_hit_tokens
    ?? parsed.usage?.prompt_tokens_details?.cached_tokens;
  const reasoningTokens = parsed.usage?.completion_tokens_details?.reasoning_tokens;
  return {
    id: parsed.id ?? "unknown",
    provider: request.spec.provider,
    model: returnedModel,
    content,
    latencyMs: performance.now() - startedAt,
    usage: {
      promptTokens: parsed.usage?.prompt_tokens ?? 0,
      completionTokens: parsed.usage?.completion_tokens ?? 0,
      totalTokens: parsed.usage?.total_tokens ?? 0,
      ...(typeof cachedPromptTokens === "number" ? { cachedPromptTokens } : {}),
      ...(typeof reasoningTokens === "number" ? { reasoningTokens } : {}),
    },
  };
}

export function isRetryableJudgeError(error: unknown): boolean {
  return error instanceof JudgeHttpError ? error.retryable
    : error instanceof SyntaxError
      || (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError"));
}
