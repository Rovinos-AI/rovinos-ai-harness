// SPDX-License-Identifier: Apache-2.0
import { build } from "esbuild";

const entryPoint = new URL("./src/index.ts", import.meta.url).pathname;

const shared = {
  entryPoints: [entryPoint],
  bundle: true,
  platform: "browser",
  target: "es2022",
  minify: true,
};

await Promise.all([
  build({
    ...shared,
    outfile: new URL("./dist/index.js", import.meta.url).pathname,
    format: "esm",
  }),
  build({
    ...shared,
    outfile: new URL("./dist/index.iife.js", import.meta.url).pathname,
    format: "iife",
    globalName: "HarnessAppTelemetry",
  }),
]);
