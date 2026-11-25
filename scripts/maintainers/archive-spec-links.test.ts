// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import { archiveSpecLinks, isApply, rewriteSpecLinks } from "./archive-spec-links.ts";

const root = "https://github.com/Rovinos-AI/rovinos-ai-harness/blob/main/";
const oldRoot = "https://github.com/rovinoscr/rovinos-ai-harness/blob/main/";

describe("rewriteSpecLinks", () => {
  it("rewrites all spec links while preserving anchors and other content", () => {
    const body = [
      `[epic](${root}packages/core/epic-15-core.md#task-15-1)`,
      `<${oldRoot}scripts/TASKS.md#section>`,
      `${root}docs/engineering/tasks/README.md?plain=1#intro`,
      `${root}packages/core/README.md`,
      `${root}scripts/TASKS.md.`,
      `${root}scripts/TASKS.md.backup`,
      "https://github.com/other/rovinos-ai-harness/blob/main/scripts/TASKS.md",
      `${root.replace("/main/", "/specs-archive/")}scripts/TASKS.md`,
      "unrelated text",
    ].join("\n");
    const expected = body
      .replace(
        `${root}packages/core/epic-15-core.md`,
        `${root.replace("/main/", "/specs-archive/")}packages/core/epic-15-core.md`,
      )
      .replace(
        `${oldRoot}scripts/TASKS.md`,
        `${oldRoot.replace("/main/", "/specs-archive/")}scripts/TASKS.md`,
      )
      .replace(
        `${root}docs/engineering/tasks/README.md`,
        `${root.replace("/main/", "/specs-archive/")}docs/engineering/tasks/README.md`,
      )
      .replace(
        `${root}scripts/TASKS.md.`,
        `${root.replace("/main/", "/specs-archive/")}scripts/TASKS.md.`,
      );
    const result = rewriteSpecLinks(body);
    expect(result).toEqual({ body: expected, count: 4 });
    expect(rewriteSpecLinks(result.body)).toEqual({ body: expected, count: 0 });
  });

  it.each(["--unknown", "--apply --dry-run"])("rejects invalid mode %s", (arg) => {
    expect(() => isApply(arg.split(" "))).toThrow();
  });
});

describe("archiveSpecLinks", () => {
  it("defaults to read-only and visits every page without writing", async () => {
    const report = vi.fn();
    const first = [
      { number: 1, body: `${root}scripts/TASKS.md` },
      { number: 2, body: `${oldRoot}docs/engineering/tasks/README.md` },
      { number: 3, body: `${root}scripts/TASKS.md`, pull_request: {} },
      ...Array.from({ length: 97 }, (_, index) => ({ number: index + 4, body: null })),
    ];
    const request = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      expect(init?.method).toBeUndefined();
      const url = input instanceof Request ? input.url : input.toString();
      return Promise.resolve(
        Response.json(
          url.endsWith("page=1") ? first : [{ number: 101, body: `${root}docs/epic-21-docs.md` }],
        ),
      );
    });
    expect(isApply([])).toBe(false);
    expect(isApply(["--dry-run"])).toBe(false);
    await archiveSpecLinks(isApply([]), "synthetic", { request, report });
    expect(request).toHaveBeenCalledTimes(2);
    expect(report.mock.calls).toEqual([["#1: 1 link(s)"], ["#2: 1 link(s)"], ["#101: 1 link(s)"]]);
  });

  it("checks the tag and updates only the rewritten body in apply mode", async () => {
    const body = `before ${oldRoot}scripts/TASKS.md#x after`;
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const request = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input.toString();
      calls.push({ url, init });
      if (url.endsWith("/git/ref/tags/specs-archive")) {
        return Promise.resolve(Response.json({ ref: "refs/tags/specs-archive" }));
      }
      if (init?.method === "PATCH") {
        return Promise.resolve(Response.json({}));
      }
      if (url.includes("?")) {
        return Promise.resolve(Response.json([{ number: 1, body }]));
      }
      return Promise.resolve(Response.json({ number: 1, body }));
    });
    const pause = vi.fn(() => Promise.resolve());
    await archiveSpecLinks(isApply(["--apply"]), "synthetic", {
      request,
      report: () => undefined,
      pause,
    });
    expect(calls.map(({ init }) => init?.method ?? "GET")).toEqual(["GET", "GET", "GET", "PATCH"]);
    expect(pause).toHaveBeenCalledOnce();
    expect(calls[3]?.init?.body).toBe(
      JSON.stringify({ body: body.replace("/blob/main/", "/blob/specs-archive/") }),
    );
  });

  it("refuses writes when an issue changed after listing", async () => {
    const request = vi.fn((input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url.endsWith("/git/ref/tags/specs-archive")) {
        return Promise.resolve(Response.json({ ref: "refs/tags/specs-archive" }));
      }
      return Promise.resolve(
        Response.json(
          url.includes("?")
            ? [{ number: 1, body: `${root}TASKS.md` }]
            : { number: 1, body: "changed" },
        ),
      );
    });
    await expect(
      archiveSpecLinks(true, "synthetic", { request, report: () => undefined }),
    ).rejects.toThrow("changed");
    expect(request).toHaveBeenCalledTimes(3);
  });
});
