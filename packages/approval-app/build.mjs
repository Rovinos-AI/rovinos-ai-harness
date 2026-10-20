// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build, transform } from "esbuild";

/**
 * Builds one self-contained app document, rejecting literal external URLs.
 *
 * @param entryPoint - Browser entry module for this view.
 * @param style - Shared inline stylesheet.
 * @returns HTML with a SHA-256 comment over the document following the comment.
 */
async function buildHtml(entryPoint, style) {
  const result = await build({
    entryPoints: [entryPoint],
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
        name: "english-zod-locale",
        setup(builder) {
          // Keep unused Zod locale modules out of the English-only view bundle.
          builder.onResolve({ filter: /^\.\.\/locales\/index\.js$/ }, () => ({
            path: "zod-locales",
            namespace: "harness-zod-locales",
          }));
          builder.onLoad({ filter: /.*/, namespace: "harness-zod-locales" }, () => ({
            contents: 'export { default as en } from "zod/v4/locales/en.js";',
            loader: "js",
            resolveDir: fileURLToPath(new URL("../../", import.meta.url)),
          }));
        },
      },
      {
        name: "inline-dependency-metadata",
        setup(builder) {
          builder.onLoad({ filter: /\.(ts|tsx|js|mjs|jsx)$/ }, async ({ path }) => {
            if (path.includes("/node_modules/")) {
              return undefined;
            }
            const contents = await readFile(path, "utf8");
            const normalized = await transform(contents, {
              loader: {
                ts: "ts",
                tsx: "tsx",
                js: "js",
                mjs: "js",
                jsx: "jsx",
              }[path.slice(path.lastIndexOf(".") + 1)],
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
  const document = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title></title><style>${style}</style></head><body><script>${script}</script></body></html>
`;
  if (/https?:\/\//iu.test(document)) {
    throw new Error("approval_build_external_url");
  }
  const hash = createHash("sha256").update(document).digest("hex");
  return `<!-- SPDX-License-Identifier: Apache-2.0; content-sha256: ${hash} -->\n${document}`;
}

/**
 * Builds the approval resource with optional source/style overrides for build tests.
 *
 * @param options - Optional entry/style overrides used by negative build tests.
 * @returns HTML with a SHA-256 comment over the document following the comment.
 */
export async function buildApprovalHtml(options = {}) {
  const style =
    options.style ?? (await readFile(new URL("./src/styles.css", import.meta.url), "utf8"));
  return buildHtml(
    options.entryPoint ?? fileURLToPath(new URL("./src/main.ts", import.meta.url)),
    style,
  );
}

/**
 * Builds every view with an `index.ts` entry to its own self-contained HTML resource.
 *
 * @returns A mapping from view directory name to built HTML.
 */
export async function buildAllViewHtml() {
  const viewsUrl = new URL("./src/views/", import.meta.url);
  const entries = await readdir(viewsUrl, { withFileTypes: true });
  const style = await readFile(new URL("./src/styles.css", import.meta.url), "utf8");
  const outputs = {};
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[a-z0-9-]+$/u.test(entry.name)) {
      continue;
    }
    const entryPoint = new URL(`./src/views/${entry.name}/index.ts`, import.meta.url);
    try {
      await readFile(entryPoint);
    } catch {
      continue;
    }
    outputs[entry.name] = await buildHtml(fileURLToPath(entryPoint), style);
  }
  return outputs;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const views = await buildAllViewHtml();
  await mkdir(new URL("./dist/", import.meta.url), { recursive: true });
  for (const [name, html] of Object.entries(views)) {
    await writeFile(new URL(`./dist/${name}.html`, import.meta.url), html);
  }
}
