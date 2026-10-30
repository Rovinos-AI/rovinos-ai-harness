// SPDX-License-Identifier: Apache-2.0
import { Id } from "@rovinos/schemas";
import { expect, it } from "vitest";
import { readLatestStatus } from "./docker-human.js";

it("reports a coded error when a resumed run is missing", async () => {
  await expect(
    readLatestStatus(
      { listRuns: () => Promise.resolve({ runs: [] }) },
      Id.parse("00000000000000000000000000"),
    ),
  ).rejects.toMatchObject({ code: "docker_process_failed" });
});
