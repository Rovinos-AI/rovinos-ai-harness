// SPDX-License-Identifier: Apache-2.0
import { createHarness } from "@rovinos/sdk";
import { EnvSecretResolver } from "@rovinos/config";
import { Code, Id, Principal } from "@rovinos/schemas";

const [configPath, dataDir, requestId] = process.argv.slice(2);
const answer = process.env.SDK_HUMAN_INPUT_ANSWER;
if (
  configPath === undefined ||
  dataDir === undefined ||
  requestId === undefined ||
  answer === undefined
) {
  throw new Error("The SDK human-input process configuration is incomplete.");
}

let nextId = 9_000_000n;
const ids = {
  next: () => Id.parse((nextId++).toString().padStart(26, "0")),
};
let completed = false;
const model = {
  complete: () => {
    if (completed) {
      throw new Error("The resumed run requested an unexpected additional model response.");
    }
    completed = true;
    return Promise.resolve({
      parts: [{ type: "text", text: "Synthetic MCP action completed." }],
      usage: { inputTokens: 1, outputTokens: 1 },
      finishReason: "stop",
      provider: Code.parse("synthetic"),
      model: Code.parse("sdk-human-input"),
      latencyMs: 0,
      schemaValid: true,
      repairAttempts: 0,
      fallbackDepth: 0,
      providerBlobs: null,
    });
  },
};
const harness = await createHarness({
  configPath,
  overrides: {
    dataDir,
    clock: { now: () => 1_000 },
    ids,
    model,
    secretResolver: new EnvSecretResolver(),
  },
});
try {
  const resolution = await harness.answerInput(requestId, {
    action: "accept",
    content: { email: answer },
    principal: Principal.parse("cli.sdk"),
  });
  const resumed = await harness.resumeRun(resolution.runId);
  process.stdout.write(JSON.stringify({ resolution, resumed }));
} finally {
  await harness.close();
}
