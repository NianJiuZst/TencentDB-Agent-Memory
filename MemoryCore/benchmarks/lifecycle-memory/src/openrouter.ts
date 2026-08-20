import { performance } from "node:perf_hooks";

export interface ChatMessage {
  role: "system" | "user";
  content: string;
}

export interface ModelUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd?: number;
}

export interface ModelResponse {
  id: string;
  model: string;
  content: string;
  latencyMs: number;
  usage: ModelUsage;
}

export interface OpenRouterRequest {
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  temperature: number;
  maxTokens: number;
  seed: number;
  retries: number;
  json?: boolean;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => part && typeof part === "object" && "text" in part ? String(part.text) : "")
    .join("");
}

export async function callOpenRouter(request: OpenRouterRequest): Promise<ModelResponse> {
  let lastError: unknown;
  for (let attempt = 0; attempt < request.retries; attempt += 1) {
    const startedAt = performance.now();
    try {
      const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${request.apiKey}`,
          "Content-Type": "application/json",
          "X-Title": "MemoryCore lifecycle headroom evaluation",
        },
        body: JSON.stringify({
          model: request.model,
          messages: request.messages,
          temperature: request.temperature,
          max_tokens: request.maxTokens,
          seed: request.seed,
          ...(request.json ? { response_format: { type: "json_object" } } : {}),
        }),
        signal: AbortSignal.timeout(120_000),
      });
      const body = await response.text();
      if (!response.ok) {
        throw new Error(`OpenRouter HTTP ${response.status}: ${body.slice(0, 500)}`);
      }
      const parsed = JSON.parse(body) as {
        id?: string;
        model?: string;
        choices?: Array<{ message?: { content?: unknown } }>;
        usage?: {
          prompt_tokens?: number;
          completion_tokens?: number;
          total_tokens?: number;
          cost?: number;
        };
      };
      const content = contentText(parsed.choices?.[0]?.message?.content).trim();
      if (!content) throw new Error("OpenRouter returned an empty response");
      return {
        id: parsed.id ?? "unknown",
        model: parsed.model ?? request.model,
        content,
        latencyMs: performance.now() - startedAt,
        usage: {
          promptTokens: parsed.usage?.prompt_tokens ?? 0,
          completionTokens: parsed.usage?.completion_tokens ?? 0,
          totalTokens: parsed.usage?.total_tokens ?? 0,
          ...(typeof parsed.usage?.cost === "number" ? { costUsd: parsed.usage.cost } : {}),
        },
      };
    } catch (error) {
      lastError = error;
      if (attempt + 1 < request.retries) await delay(500 * 2 ** attempt);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
