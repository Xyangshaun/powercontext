import { pipeline, env } from "@huggingface/transformers";

env.allowRemoteModels = false;
env.allowLocalModels = true;
env.localModelPath = "/models/";
env.backends.onnx.wasm.wasmPaths = "/vendor/ort/";
env.backends.onnx.wasm.numThreads = 1;

const MODEL_ID = "bge-small-en-v1.5";
const DIM = 384;
let extractor = null;
let deviceUsed = null;
let lastError = null;

function base64Float32(f32) {
  const u8 = new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength);
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < u8.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, u8.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

async function init(preferWebGPU) {
  const attempts = [];
  if (preferWebGPU && typeof navigator !== "undefined" && navigator.gpu) attempts.push("webgpu");
  attempts.push("wasm");
  const failures = [];
  for (const device of attempts) {
    const t0 = performance.now();
    try {
      self.postMessage({ type: "stage", stage: "model-load", device, status: "start" });
      extractor = await pipeline("feature-extraction", MODEL_ID, {
        dtype: "q8",
        device,
        progress_callback: (p) => self.postMessage({ type: "progress", payload: p }),
      });
      deviceUsed = device;
      return {
        device,
        loadMs: performance.now() - t0,
        dim: DIM,
        dtype: "q8",
        failures,
        gpuAdapter: device === "webgpu" ? "webgpu" : null,
      };
    } catch (err) {
      lastError = String(err?.message || err);
      failures.push({ device, error: lastError });
      self.postMessage({ type: "stage", stage: "model-load", device, status: "failed", error: lastError });
    }
  }
  throw new Error(failures.map((f) => `${f.device}: ${f.error}`).join(" | ") || lastError);
}

async function embed(texts, batchSize = 16) {
  if (!extractor) throw new Error("model not loaded");
  const vectors = [];
  const t0 = performance.now();
  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    const out = await extractor(batch, { pooling: "cls", normalize: true });
    const data = out.data;
    for (let r = 0; r < batch.length; r++) {
      vectors.push(new Float32Array(data.slice(r * DIM, (r + 1) * DIM)));
    }
    self.postMessage({ type: "embed-progress", done: Math.min(i + batch.length, texts.length), total: texts.length });
  }
  return { vectors, embedMs: performance.now() - t0 };
}

self.onmessage = async (event) => {
  const msg = event.data;
  try {
    if (msg.type === "init") {
      const info = await init(msg.preferWebGPU !== false);
      self.postMessage({ type: "ready", info });
    } else if (msg.type === "embed") {
      const { vectors, embedMs } = await embed(msg.texts, msg.batchSize);
      self.postMessage({
        type: "embedded",
        requestId: msg.requestId,
        embedMs,
        device: deviceUsed,
        vectors: vectors.map(base64Float32),
      });
    } else if (msg.type === "ping") {
      self.postMessage({ type: "pong", loaded: Boolean(extractor), device: deviceUsed });
    }
  } catch (err) {
    self.postMessage({ type: "error", requestId: msg.requestId, error: String(err?.message || err) });
  }
};
