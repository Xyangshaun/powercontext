import { build } from "esbuild";

// Bundle the worker so that browser-native ESM does not have to resolve
// bare specifiers such as "onnxruntime-web/webgpu".
await build({
  entryPoints: ["src/embed-worker.src.js"],
  outfile: "public/embed-worker.js",
  bundle: true,
  format: "esm",
  platform: "browser",
  target: ["chrome120", "safari17"],
  minify: true,
  sourcemap: false,
  legalComments: "none",
  conditions: ["browser"],
  logLevel: "info",
});
