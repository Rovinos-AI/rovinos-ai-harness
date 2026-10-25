// SPDX-License-Identifier: Apache-2.0
import { createHarness } from "@rovinos/sdk";

const harness = await createHarness({ configPath: "harness.config.yaml" });
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
