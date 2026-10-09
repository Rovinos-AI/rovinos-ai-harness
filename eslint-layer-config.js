// SPDX-License-Identifier: Apache-2.0
import { createHarnessPlugin } from "@harness/eslint-plugin-harness";
import { z } from "zod";
import layersDocument from "./docs/engineering/layers.json" with { type: "json" };

const layersSchema = z.record(z.string(), z.union([z.string(), z.array(z.string())]));
const layers = layersSchema.parse(layersDocument);

/** Validated package layers supplied to the custom ESLint rules. */
export const harnessPlugin = createHarnessPlugin(layers);
