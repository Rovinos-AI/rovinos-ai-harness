// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

export const WeatherSchema = z
  .object({
    city: z.string(),
    temperatureC: z.number(),
  })
  .strict();

export type Weather = z.infer<typeof WeatherSchema>;
