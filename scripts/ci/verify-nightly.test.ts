// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { parseYaml } from "@harness/schemas";
import { z } from "zod";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const nightlyPipelineSchema = z.looseObject({
  trigger: z.literal("none"),
  pr: z.literal("none"),
  schedules: z.array(
    z.looseObject({
      cron: z.string(),
      branches: z.looseObject({ include: z.array(z.string()) }),
    }),
  ),
  jobs: z.array(z.looseObject({ steps: z.array(z.record(z.string(), z.unknown())) })),
});

it("runs the live Key Vault test nightly with Azure CLI authentication", () => {
  const pipeline = parseYaml(
    nightlyPipelineSchema,
    readFileSync(resolve(root, "azure-pipelines-nightly.yml"), "utf8"),
  );
  const steps = pipeline.jobs[0]?.steps ?? [];
  const azureCli = steps.find((step) => step.task === "AzureCLI@2");

  expect(pipeline.schedules[0]?.branches.include).toEqual(["main"]);
  expect(pipeline.schedules[0]?.cron).toBe("0 3 * * *");
  expect(azureCli?.inputs).toMatchObject({
    azureSubscription: "$(HARNESS_AKV_SERVICE_CONNECTION)",
    inlineScript: "yarn test:live:akv",
  });
  expect(azureCli?.env).toEqual({ HARNESS_LIVE_AKV: "$(HARNESS_LIVE_AKV)" });
});
