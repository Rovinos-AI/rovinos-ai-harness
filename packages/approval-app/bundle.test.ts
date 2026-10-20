// SPDX-License-Identifier: Apache-2.0
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { buildAllViewHtml, buildApprovalHtml } from "./build.mjs";

async function contentHash(html: string): Promise<string> {
  const newline = html.indexOf("\n");
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(html.slice(newline + 1)),
  );
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

async function gzipSize(html: string): Promise<number> {
  const stream = new Blob([html]).stream().pipeThrough(new CompressionStream("gzip"));
  return (await new Response(stream).arrayBuffer()).byteLength;
}

function viewHtmlEntries(value: unknown): { readonly name: string; readonly html: string }[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Expected view HTML output");
  }
  const entries: { name: string; html: string }[] = [];
  for (const name of Object.keys(value)) {
    const html: unknown = Reflect.get(value, name);
    if (typeof html !== "string") {
      throw new TypeError("Expected HTML for every view");
    }
    entries.push({ name, html });
  }
  return entries;
}

describe("single-file approval app", () => {
  it("builds inline script/style with a verifiable content hash and no external references", async () => {
    const html = await buildApprovalHtml();
    expect(html).not.toMatch(/https?:\/\//iu);
    const newline = html.indexOf("\n");
    const hex = await contentHash(html);
    expect(html.slice(0, newline)).toContain(`content-sha256: ${hex}`);
    const dom = new JSDOM(html);
    expect(dom.window.document.querySelectorAll("script")).toHaveLength(1);
    expect(dom.window.document.querySelectorAll("style")).toHaveLength(1);
    expect(dom.window.document.querySelectorAll("[src], [href], [srcset], [onload]")).toHaveLength(
      0,
    );
    expect(dom.window.document.querySelector("script")?.textContent).not.toContain("eval(");
    expect(dom.window.document.documentElement.lang).toBe("en");
    dom.window.close();
  });

  it.each(["https://example.test/image", "HTTP://example.test/font"])(
    "refuses a stylesheet referencing %s",
    async (url) => {
      await expect(
        buildApprovalHtml({ style: `body { background: url("${url}"); }` }),
      ).rejects.toThrow("approval_build_external_url");
    },
  );

  it("refuses an external URL introduced by app source", async () => {
    await expect(
      buildApprovalHtml({
        entryPoint: new URL("./fixtures/external-url.ts", import.meta.url).pathname,
      }),
    ).rejects.toThrow("approval_build_external_url");
  });

  it("refuses an external URL introduced by a JSX app module", async () => {
    await expect(
      buildApprovalHtml({
        entryPoint: new URL("./fixtures/external-url.jsx", import.meta.url).pathname,
      }),
    ).rejects.toThrow("approval_build_external_url");
  });

  it("strips documentation URL comments before checking app source", async () => {
    const html = await buildApprovalHtml({
      entryPoint: new URL("./fixtures/documentation-url.ts", import.meta.url).pathname,
    });
    expect(html).not.toMatch(/https?:\/\//iu);
    expect(html).toContain("content-sha256:");
  });

  it("builds one hashed, self-contained HTML document per view within the gzip budget", async () => {
    const views = viewHtmlEntries(
      await buildAllViewHtml({
        entries: {
          configured: new URL("./fixtures/configured-view.ts", import.meta.url),
        },
      }),
    );
    expect(views.map(({ name }) => name)).toEqual(["approval", "configured"]);
    for (const { html } of views) {
      expect(html).not.toMatch(/https?:\/\//iu);
      expect(await gzipSize(html)).toBeLessThanOrEqual(150 * 1024);
      const newline = html.indexOf("\n");
      const hash = await contentHash(html);
      expect(html.slice(0, newline)).toContain(`content-sha256: ${hash}`);
      const dom = new JSDOM(html);
      expect(dom.window.document.querySelectorAll("script")).toHaveLength(1);
      expect(dom.window.document.querySelectorAll("style")).toHaveLength(1);
      expect(dom.window.document.querySelectorAll("[src], [href], [srcset]")).toHaveLength(0);
      dom.window.close();
    }
  });

  it("keeps both theme palettes above 4.5:1 and provides focus, reduced-motion, and wrapping styles", async () => {
    const html = await buildApprovalHtml();
    const style = new JSDOM(html).window.document.querySelector("style")?.textContent ?? "";
    const luminance = (hex: string) => {
      const rgb = [0, 2, 4].map(
        (offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255,
      );
      const linear = rgb.map((value) =>
        value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4,
      );
      return (linear[0] ?? 0) * 0.2126 + (linear[1] ?? 0) * 0.7152 + (linear[2] ?? 0) * 0.0722;
    };
    for (const [text, background] of [
      ["172033", "ffffff"],
      ["172033", "e2e8f0"],
      ["475569", "edf2f7"],
      ["f1f5f9", "121826"],
      ["f1f5f9", "273449"],
      ["cbd5e1", "273449"],
    ]) {
      const a = luminance(text ?? "");
      const b = luminance(background ?? "");
      expect((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)).toBeGreaterThanOrEqual(4.5);
    }
    for (const rule of [
      "prefers-color-scheme: dark",
      "prefers-reduced-motion: reduce",
      ":focus-visible",
      "overflow-wrap: anywhere",
      "flex-wrap: wrap",
      '[data-display-mode="fullscreen"]',
      '[data-display-mode="pip"]',
      "@media (max-width: 480px)",
    ]) {
      expect(style).toContain(rule);
    }
    expect(style).toMatch(/\[data-theme="light"\]\s*\{\s*color-scheme:\s*light;/u);
  });
});
