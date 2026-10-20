// SPDX-License-Identifier: Apache-2.0
import { SecretRefSchema } from "@harness/schemas";
import { describe, expect, it } from "vitest";
import { AkvSecretResolver } from "./akv.js";

const liveReference = process.env.HARNESS_LIVE_AKV;
const hasLiveReference =
  liveReference !== undefined &&
  liveReference.trim().length > 0 &&
  liveReference !== "$(HARNESS_LIVE_AKV)";

describe.skipIf(!hasLiveReference)("LIVE Azure Key Vault", () => {
  it("reads the configured test secret through DefaultAzureCredential", async () => {
    if (!hasLiveReference) {
      throw new Error("live_akv_reference_required");
    }
    const secret = await new AkvSecretResolver().resolve(SecretRefSchema.parse(liveReference));

    expect(secret.reveal().length).toBeGreaterThan(0);
  });
});
