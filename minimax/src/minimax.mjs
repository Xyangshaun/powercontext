// MiniMax 客户端：只用环境变量 MINIMAX_API_KEY，不落盘、不进仓库。
const DEFAULT_BASE = "https://api.minimaxi.com/v1/text/chatcompletion_v2";
const DEFAULT_MODEL = "MiniMax-Text-01";

export function hasKey() {
  return Boolean(process.env.MINIMAX_API_KEY && process.env.MINIMAX_API_KEY.trim());
}

export function endpoint() {
  return process.env.MINIMAX_BASE_URL || DEFAULT_BASE;
}

export function modelName() {
  return process.env.MINIMAX_MODEL || DEFAULT_MODEL;
}

// 真实调用 MiniMax ChatCompletion v2，返回可落盘证据的元数据（不含 key）。
export async function chat(messages, opts = {}) {
  const key = (process.env.MINIMAX_API_KEY || "").trim();
  if (!key) throw new Error("MINIMAX_API_KEY 未设置，拒绝发起调用");
  const endpointUrl = endpoint();
  const model = opts.model || modelName();
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const res = await fetch(endpointUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model,
      messages,
      max_tokens: opts.maxTokens || 2048,
      temperature: opts.temperature ?? 0.2,
    }),
  });
  const latencyMs = Date.now() - t0;
  const rawText = await res.text();
  let body;
  try {
    body = JSON.parse(rawText);
  } catch {
    throw new Error(`MiniMax 返回非 JSON（HTTP ${res.status}）：${rawText.slice(0, 300)}`);
  }
  if (!res.ok) throw new Error(`MiniMax HTTP ${res.status}：${rawText.slice(0, 300)}`);
  if (body.base_resp && body.base_resp.status_code !== 0) {
    throw new Error(`MiniMax 业务错误 ${body.base_resp.status_code}：${body.base_resp.status_msg}`);
  }
  const choice = (body.choices || [])[0] || {};
  const content = (choice.message && choice.message.content) || "";
  return {
    endpoint: endpointUrl,
    model: body.model || model,
    requestId: body.id,
    startedAt,
    latencyMs,
    usage: body.usage || null,
    content,
    reasoningContent: (choice.message && choice.message.reasoning_content) || "",
  };
}
