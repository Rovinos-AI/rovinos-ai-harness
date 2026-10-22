// SPDX-License-Identifier: Apache-2.0
// This example uses synthetic data only.
import { defineSuite } from "@harness/eval";

export default defineSuite({
  schemaVersion: 1,
  tasks: [
    {
      id: "create_readme",
      description: "Create a short README in a synthetic workspace.",
      input: { goal: "Create a README that contains the phrase Hello harness." },
      graders: [
        {
          type: "file_diff",
          path: "README.md",
          expectedContains: "Hello harness.",
        },
        { type: "no_canary_leak" },
      ],
      tags: ["basic", "synthetic"],
    },
  ],
});
