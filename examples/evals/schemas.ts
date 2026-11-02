// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

/** Validates the synthetic weather extraction response. */
export const WeatherSchema = z
  .object({
    city: z.string(),
    temperatureC: z.number(),
  })
  .strict();

/** Inferred shape of the weather extraction response. */
export type Weather = z.infer<typeof WeatherSchema>;
