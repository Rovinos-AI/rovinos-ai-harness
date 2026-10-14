// SPDX-License-Identifier: Apache-2.0
import { copyFile, mkdir } from "node:fs/promises";
import { build } from "esbuild";

const output = new URL("./dist/web/", import.meta.url);
await mkdir(output, { recursive: true });
await copyFile(new URL("./src/web/index.html", import.meta.url), new URL("index.html", output));
await build({
  entryPoints: [new URL("./src/web/host-page.ts", import.meta.url).pathname],
  outfile: new URL("host.js", output).pathname,
  bundle: true,
  platform: "browser",
  format: "iife",
  target: "es2022",
  minify: true,
});
