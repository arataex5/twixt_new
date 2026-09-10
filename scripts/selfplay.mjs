// scripts/selfplay.ts を rolldown で束ねて Node で実行するランチャー
// 例: npm run selfplay -- --pairs 3:4,4:5 --games 20 --jobs 4 --out scripts/results/3-4.json
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { build } from "rolldown";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, ".build");
mkdirSync(outDir, { recursive: true });
await build({
  input: join(here, "selfplay.ts"),
  platform: "node",
  external: [/^onnxruntime-web/, /^node:/],
  output: { dir: outDir, format: "esm", entryFileNames: "selfplay.mjs" },
  logLevel: "silent",
});
const child = spawn(process.execPath, [join(outDir, "selfplay.mjs"), ...process.argv.slice(2)], { stdio: "inherit" });
child.on("exit", (code) => process.exit(code ?? 1));
