// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { checkExternalLinks } from "./check-external-links.js";
import type { MarkdownSource } from "./markdown.js";

describe("external Markdown link checker", () => {
  it("checks deduplicated HTTP links only when explicitly invoked", async () => {
    const sources: MarkdownSource[] = [
      {
        path: "README.md",
        contents:
          "[website](https://example.test/one) <https://example.test/one> https://example.test/two",
      },
    ];
    const requested: string[] = [];
    const issues = await checkExternalLinks(sources, (input) => {
      if (typeof input === "string") {
        requested.push(input);
      } else if (input instanceof URL) {
        requested.push(input.href);
      } else {
        requested.push(input.url);
      }
      return Promise.resolve(new Response(null, { status: 204 }));
    });

    expect(issues).toEqual([]);
    expect(requested).toEqual(["https://example.test/one", "https://example.test/two"]);
  });

  it("reports failed requests without exposing their URL", async () => {
    const issues = await checkExternalLinks(
      [{ path: "README.md", contents: "[website](https://example.test/private)" }],
      () => Promise.resolve(new Response(null, { status: 404 })),
    );

    expect(issues).toEqual([
      {
        path: "README.md",
        line: 1,
        reason: "external HTTP link returned status 404",
      },
    ]);
  });

  it("falls back to a ranged GET when a host rejects HEAD", async () => {
    const methods: string[] = [];
    const issues = await checkExternalLinks(
      [{ path: "README.md", contents: "[website](https://example.test/)" }],
      (_input, options) => {
        methods.push(options?.method ?? "");
        return Promise.resolve(new Response(null, { status: methods.length === 1 ? 405 : 204 }));
      },
    );

    expect(issues).toEqual([]);
    expect(methods).toEqual(["HEAD", "GET"]);
  });

  it("does not make requests to literal IP addresses", async () => {
    let requested = false;
    const issues = await checkExternalLinks(
      [{ path: "README.md", contents: "[internal](http://127.0.0.1/)" }],
      () => {
        requested = true;
        return Promise.resolve(new Response(null, { status: 204 }));
      },
    );

    expect(requested).toBe(false);
    expect(issues[0]?.reason).toBe("external URL host is not allowed");
  });
});
