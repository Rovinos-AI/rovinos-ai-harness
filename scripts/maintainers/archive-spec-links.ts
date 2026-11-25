// SPDX-License-Identifier: Apache-2.0
// (verify) Running this issue-processing script opts in to GitHub reads; only --apply permits writes.
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { parseJson } from "@rovinos/schemas";
import { z } from "zod";

const api = "https://api.github.com/repos/Rovinos-AI/rovinos-ai-harness";
const issueSchema = z
  .object({
    number: z.number().int().positive(),
    body: z.string().nullable(),
    pull_request: z.unknown().optional(),
  })
  .loose();
const issuesSchema = z.array(issueSchema);
const tagSchema = z.object({ ref: z.literal("refs/tags/specs-archive") }).loose();
type Issue = z.infer<typeof issueSchema>;
interface ArchiveOptions {
  request?: typeof fetch;
  report?: (message: string) => void;
  pause?: () => Promise<void>;
}

/** Replaces only branch references in links to the spec files removed by task 27.4. */
export function rewriteSpecLinks(body: string): { body: string; count: number } {
  let count = 0;
  const rewritten = body.replaceAll(
    /https:\/\/github\.com\/(?:Rovinos-AI|rovinoscr)\/rovinos-ai-harness\/blob\/main\/([^\s<>"'`?#)\]]+)/gi,
    (link, path: string) => {
      const specPath = path.replace(/[.,;:!]+$/, "");
      if (!(
        /(?:^|\/)epic-[^/]+\.md$/i.test(specPath) ||
        /(?:^|\/)TASKS\.md$/i.test(specPath) ||
        /^docs\/engineering\/tasks\/.+\.md$/i.test(specPath)
      )) {
        return link;
      }
      count += 1;
      return link.replace(/\/blob\/main\//i, "/blob/specs-archive/");
    },
  );
  return { body: rewritten, count };
}

/** Processes every issue, including closed issues; pull requests are excluded. */
export async function archiveSpecLinks(
  apply: boolean,
  token: string,
  options: ArchiveOptions = {},
): Promise<void> {
  const request = options.request ?? fetch;
  const report = options.report ?? ((message: string) => process.stdout.write(`${message}\n`));
  const pause = options.pause ?? (() => sleep(1000));
  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: ["Bearer", token].join(" "),
    "X-GitHub-Api-Version": "2022-11-28",
  };
  async function get(path: string): Promise<string> {
    const response = await request(`${api}${path}`, { headers, redirect: "error" });
    if (!response.ok) {
      throw new Error(`GitHub read failed (${String(response.status)})`);
    }
    return response.text();
  }

  if (apply) {
    parseJson(tagSchema, await get("/git/ref/tags/specs-archive"));
  }

  for (let page = 1; ; page += 1) {
    const issues = parseJson(
      issuesSchema,
      await get(`/issues?state=all&per_page=100&page=${String(page)}`),
      { maxBytes: 64 * 1024 * 1024 },
    );
    for (const issue of issues) {
      if (issue.pull_request !== undefined || issue.body === null) {
        continue;
      }
      const rewritten = rewriteSpecLinks(issue.body);
      if (rewritten.count === 0) {
        continue;
      }
      report(`#${String(issue.number)}: ${String(rewritten.count)} link(s)`);
      if (apply) {
        const current: Issue = parseJson(issueSchema, await get(`/issues/${String(issue.number)}`));
        if (current.body !== issue.body) {
          throw new Error(`Issue #${String(issue.number)} changed; rerun the script`);
        }
        const response = await request(`${api}/issues/${String(issue.number)}`, {
          method: "PATCH",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify({ body: rewritten.body }),
          redirect: "error",
        });
        if (!response.ok) {
          throw new Error(`GitHub write failed (${String(response.status)})`);
        }
        await pause();
      }
    }
    if (issues.length < 100) {
      break;
    }
  }
}

/** Parses the mode before performing any network operations. */
export function isApply(args: readonly string[]): boolean {
  if (args.length > 1 || (args.length === 1 && args[0] !== "--dry-run" && args[0] !== "--apply")) {
    throw new Error("Usage: archive-spec-links.ts [--dry-run | --apply]");
  }
  return args[0] === "--apply";
}

async function main(): Promise<void> {
  const apply = isApply(process.argv.slice(2));
  const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  if (token === undefined || token.length === 0) {
    throw new Error("Set GH_TOKEN or GITHUB_TOKEN");
  }
  await archiveSpecLinks(apply, token);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    process.stderr.write(
      "Archive operation failed; check arguments, token, tag, API access, and rate limits before rerunning.\n",
    );
    process.exitCode = 1;
  });
}
