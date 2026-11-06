import { readFileSync } from "node:fs";
import { defineConfig } from "tsup";

const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string };

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["cjs", "esm"],
  dts: false,
  splitting: false,
  sourcemap: true,
  clean: true,
  target: "node18",
  define: { __TENKI_SDK_VERSION__: JSON.stringify(version) },
  outExtension({ format }) {
    return { js: format === "esm" ? ".mjs" : ".cjs" };
  },
});
