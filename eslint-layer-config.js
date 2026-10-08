// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import { createHarnessPlugin } from "@harness/eslint-plugin-harness";
import { parseJson } from "@harness/schemas";
import { z } from "zod";

const layersSchema = z.record(z.string(), z.union([z.string(), z.array(z.string())]));
const layers = parseJson(
  layersSchema,
  readFileSync(new URL("./docs/engineering/layers.json", import.meta.url), "utf8"),
);

/** Validated package layers supplied to the custom ESLint rules. */
export const harnessPlugin = createHarnessPlugin(layers);
