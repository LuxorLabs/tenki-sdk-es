import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

import { SDK_VERSION } from "../src/version.js";

it("matches the package version", () => {
  const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    version: string;
  };
  expect(SDK_VERSION).toBe(version);
});
