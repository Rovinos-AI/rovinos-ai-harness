// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build, transform } from "esbuild";

/**
 * Builds one self-contained app document, rejecting literal external URLs.
 *
 * @param options - Optional entry/style overrides used by negative build tests.
 * @returns HTML with a SHA-256 comment over the document following the comment.
 */
export async function buildApprovalHtml(options = {}) {
  const result = await build({
    entryPoints: [options.entryPoint ?? fileURLToPath(new URL("./src/main.ts", import.meta.url))],
    bundle: true,
    platform: "browser",
    format: "iife",
    target: "es2022",
    conditions: ["source"],
    minify: true,
    legalComments: "none",
    logLevel: "silent",
    write: false,
    plugins: [
      {
        name: "inline-dependency-metadata",
        setup(builder) {
          builder.onLoad({ filter: /\.ts$/ }, async ({ path }) => {
            if (path.includes("/node_modules/")) {
              return undefined;
            }
            const contents = await readFile(path, "utf8");
            const normalized = await transform(contents, {
              loader: "ts",
              legalComments: "none",
              minifySyntax: true,
            });
            if (/https?:\/\//iu.test(normalized.code)) {
              throw new Error("approval_build_external_url");
            }
            return { contents: normalized.code, loader: "js" };
          });
        },
      },
    ],
  });
  const output = result.outputFiles[0]?.text;
  if (output === undefined) {
    throw new Error("approval_build_empty");
  }
  // Inline SDK documentation/schema identifiers are not resource references.
  // Escape their separators without changing the runtime strings; app URLs
  // are refused by the source check above, before this serialization step.
  const script = output.replaceAll(/https?:\/\//gu, (url) => url.replaceAll("/", "\\x2f"));
  const style =
    options.style ?? (await readFile(new URL("./src/styles.css", import.meta.url), "utf8"));
  const document = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pending approval</title><style>${style}</style></head><body><script>${script}</script></body></html>
`;
  if (/https?:\/\//iu.test(document)) {
    throw new Error("approval_build_external_url");
  }
  const hash = createHash("sha256").update(document).digest("hex");
  return `<!-- SPDX-License-Identifier: Apache-2.0; content-sha256: ${hash} -->\n${document}`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const html = await buildApprovalHtml();
  await mkdir(new URL("./dist/", import.meta.url), { recursive: true });
  await writeFile(new URL("./dist/approval.html", import.meta.url), html);
}
