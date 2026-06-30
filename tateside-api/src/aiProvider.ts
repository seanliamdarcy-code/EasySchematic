const OPENROUTER_CHAT_API_URL = "https://openrouter.ai/api/v1/chat/completions";
const OPENROUTER_MODELS_API_URL = "https://openrouter.ai/api/v1/models";

export type ReasoningEffort = "low" | "medium" | "high";

export interface AiWorkflowConfig {
  quoteExtractionModel: string;
  deviceResearchModel: string;
  deviceEscalationModel: string;
  quoteExtractionReasoningEffort: ReasoningEffort;
  deviceResearchReasoningEffort: ReasoningEffort;
  deviceEscalationReasoningEffort: ReasoningEffort;
}

export interface AiModelSummary {
  id: string;
  name: string;
  contextLength?: number;
}

export interface AiJsonResponse {
  outputText: string;
  sources: WebSearchSource[];
}

export interface WebSearchSource {
  title: string;
  url: string;
}

const FALLBACK_MODEL_LIST: AiModelSummary[] = [
  { id: "anthropic/claude-sonnet-4.5:online", name: "Claude Sonnet 4.5 Online" },
  { id: "google/gemini-2.5-pro:online", name: "Gemini 2.5 Pro Online" },
  { id: "openrouter/auto", name: "OpenRouter Auto" },
  { id: "perplexity/sonar-pro", name: "Perplexity Sonar Pro" },
];

export function getAiWorkflowConfig(): AiWorkflowConfig {
  return {
    quoteExtractionModel: process.env.OPENROUTER_QUOTE_EXTRACTION_MODEL || "google/gemini-2.5-pro",
    deviceResearchModel: process.env.OPENROUTER_DEVICE_RESEARCH_MODEL || "anthropic/claude-sonnet-4.5:online",
    deviceEscalationModel: process.env.OPENROUTER_DEVICE_ESCALATION_MODEL || "google/gemini-2.5-pro:online",
    quoteExtractionReasoningEffort: normalizeEffort(process.env.OPENROUTER_QUOTE_EXTRACTION_REASONING_EFFORT, "low"),
    deviceResearchReasoningEffort: normalizeEffort(process.env.OPENROUTER_DEVICE_RESEARCH_REASONING_EFFORT, "low"),
    deviceEscalationReasoningEffort: normalizeEffort(process.env.OPENROUTER_DEVICE_ESCALATION_REASONING_EFFORT, "low"),
  };
}

export function hasAiProviderKey(): boolean {
  return Boolean(process.env.OPENROUTER_API_KEY);
}

export async function listAiModels(): Promise<AiModelSummary[]> {
  const response = await fetch(OPENROUTER_MODELS_API_URL, {
    headers: openRouterHeaders(false),
  });

  const responseJson = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(errorMessageFromResponse(responseJson, `OpenRouter model list failed (${response.status})`));
  }

  const data = Array.isArray((responseJson as { data?: unknown[] } | null)?.data)
    ? (responseJson as { data?: unknown[] }).data ?? []
    : [];

  const models = data
    .map((item): AiModelSummary | null => {
      if (!item || typeof item !== "object") return null;
      const id = typeof (item as { id?: unknown }).id === "string" ? (item as { id: string }).id : "";
      if (!id) return null;
      const name = typeof (item as { name?: unknown }).name === "string" ? (item as { name: string }).name : id;
      const contextLength = typeof (item as { context_length?: unknown }).context_length === "number"
        ? (item as { context_length: number }).context_length
        : undefined;
      return { id, name, contextLength };
    })
    .filter((model): model is AiModelSummary => model !== null)
    .sort((a, b) => a.name.localeCompare(b.name));

  return models.length > 0 ? models : FALLBACK_MODEL_LIST;
}

export function fallbackAiModels(): AiModelSummary[] {
  return [...FALLBACK_MODEL_LIST];
}

export async function createAiJsonResponse(input: {
  model: string;
  reasoningEffort: ReasoningEffort;
  prompt: string;
  schemaName: string;
  schema: Record<string, unknown>;
  webSearch?: boolean;
}): Promise<AiJsonResponse> {
  if (!process.env.OPENROUTER_API_KEY) {
    throw new Error("AI research is not available because OPENROUTER_API_KEY is not configured on the TateSide API server");
  }

  const response = await fetch(OPENROUTER_CHAT_API_URL, {
    method: "POST",
    headers: openRouterHeaders(true),
    body: JSON.stringify({
      model: input.model,
      messages: [
        {
          role: "user",
          content: input.prompt,
        },
      ],
      reasoning: { effort: input.reasoningEffort },
      ...(input.webSearch ? { plugins: [{ id: "web", max_results: 3 }] } : {}),
      response_format: {
        type: "json_schema",
        json_schema: {
          name: input.schemaName,
          strict: true,
          schema: input.schema,
        },
      },
    }),
  });

  const responseJson = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(errorMessageFromResponse(responseJson, `OpenRouter request failed (${response.status})`));
  }

  const outputText = extractOutputText(responseJson);
  return {
    outputText,
    sources: extractWebSearchSources(responseJson),
  };
}

function normalizeEffort(value: string | undefined, fallback: ReasoningEffort): ReasoningEffort {
  if (value === "low" || value === "medium" || value === "high") return value;
  return fallback;
}

function openRouterHeaders(includeJson: boolean): Record<string, string> {
  const headers: Record<string, string> = {
    "HTTP-Referer": process.env.OPENROUTER_SITE_URL || "https://testschematic.tateside.online",
    "X-Title": process.env.OPENROUTER_APP_TITLE || "TateSide Schematic",
  };
  if (includeJson) {
    headers["Content-Type"] = "application/json";
  }
  if (process.env.OPENROUTER_API_KEY) {
    headers.Authorization = `Bearer ${process.env.OPENROUTER_API_KEY}`;
  }
  return headers;
}

function errorMessageFromResponse(responseJson: unknown, fallback: string): string {
  if (!responseJson || typeof responseJson !== "object") return fallback;
  const error = (responseJson as { error?: unknown }).error;
  if (typeof error === "string" && error.trim()) return error;
  if (error && typeof error === "object" && typeof (error as { message?: unknown }).message === "string") {
    return (error as { message: string }).message;
  }
  return fallback;
}

function extractOutputText(responseJson: unknown): string {
  if (!responseJson || typeof responseJson !== "object") return "";
  const choices = Array.isArray((responseJson as { choices?: unknown[] }).choices)
    ? (responseJson as { choices?: unknown[] }).choices ?? []
    : [];
  const firstChoice = choices[0];
  if (!firstChoice || typeof firstChoice !== "object") return "";
  const message = (firstChoice as { message?: unknown }).message;
  if (!message || typeof message !== "object") return "";
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (!part || typeof part !== "object") return "";
        const text = (part as { text?: unknown }).text;
        return typeof text === "string" ? text : "";
      })
      .filter(Boolean)
      .join("\n")
      .trim();
  }
  return "";
}

function extractWebSearchSources(responseJson: unknown): WebSearchSource[] {
  if (!responseJson || typeof responseJson !== "object") return [];
  const choices = Array.isArray((responseJson as { choices?: unknown[] }).choices)
    ? (responseJson as { choices?: unknown[] }).choices ?? []
    : [];
  const seen = new Set<string>();
  const sources: WebSearchSource[] = [];

  for (const choice of choices) {
    if (!choice || typeof choice !== "object") continue;
    const message = (choice as { message?: unknown }).message;
    if (!message || typeof message !== "object") continue;
    const annotations = Array.isArray((message as { annotations?: unknown[] }).annotations)
      ? (message as { annotations?: unknown[] }).annotations ?? []
      : [];
    for (const annotation of annotations) {
      if (!annotation || typeof annotation !== "object") continue;
      const citation = (annotation as { url_citation?: unknown }).url_citation;
      if (!citation || typeof citation !== "object") continue;
      const url = typeof (citation as { url?: unknown }).url === "string" ? (citation as { url: string }).url : "";
      if (!url || seen.has(url)) continue;
      seen.add(url);
      const title = typeof (citation as { title?: unknown }).title === "string" ? (citation as { title: string }).title : url;
      sources.push({ title, url });
    }
  }

  return sources;
}
