// 最小连通性验证：只读环境变量 MINIMAX_API_KEY，不写文件，打印端点/模型/request_id。
import { chat, endpoint, modelName, hasKey } from "../src/minimax.mjs";

if (!hasKey()) {
  console.error("MINIMAX_API_KEY 未设置，拒绝发起调用");
  process.exit(1);
}

const started = Date.now();
const result = await chat([{ role: "user", content: "只回复 ok" }], { maxTokens: 8 });
console.log(
  JSON.stringify(
    {
      endpoint: endpoint(),
      model: modelName(),
      request_id: result.requestId,
      latency_ms: result.latencyMs,
      usage: result.usage,
      content: result.content.slice(0, 200),
      wall_ms: Date.now() - started,
    },
    null,
    2
  )
);
