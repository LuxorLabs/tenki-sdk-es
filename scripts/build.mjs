import { execFileSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

process.chdir(fileURLToPath(new URL("..", import.meta.url)));
const { version } = JSON.parse(readFileSync("package.json", "utf8"));
writeFileSync(
  "src/version.ts",
  `// Written by scripts/build.mjs from package.json.\nexport const SDK_VERSION = ${JSON.stringify(version)};\n`,
);

rmSync("dist", { recursive: true, force: true });
// node_modules/.bin/tsc is a shell shim on Windows and under pnpm, so run the package's own bin script.
const tscManifest = createRequire(import.meta.url).resolve("@typescript/native/package.json");
const tscBin = join(dirname(tscManifest), JSON.parse(readFileSync(tscManifest, "utf8")).bin.tsc);
const tsc = (project) => execFileSync(process.execPath, [tscBin, "-p", project], { stdio: "inherit" });
tsc("tsconfig.json");
tsc("tsconfig.cjs.json");
writeFileSync("dist/cjs/package.json", `${JSON.stringify({ type: "commonjs" })}\n`);
