// SPDX-License-Identifier: Apache-2.0
import { createHarness } from "@rovinos/sdk";
import { Principal } from "@rovinos/schemas";

const harness = await createHarness({ configPath: "harness.config.yaml" });

/** Resolves a pending request and resumes the run that requested it. */
export async function answerPendingInput(
  requestId: string,
  content: { readonly email: string },
): Promise<void> {
  const resolution = await harness.answerInput(requestId, {
    action: "accept",
    content,
    principal: Principal.parse("cli.example"),
  });
  await harness.resumeRun(resolution.runId);
}

const { runId } = await harness.startRun({
  goal: "Summarize the synthetic project status.",
  idempotencyKey: "synthetic-status-summary",
});

const run = await harness.getRun(runId);
for await (const event of harness.watch(runId, { fromSeq: run.lastSeq + 1 })) {
  if (event.kind === "run_status") {
    process.stdout.write(`${event.to}\n`);
  }
}
await harness.close();
