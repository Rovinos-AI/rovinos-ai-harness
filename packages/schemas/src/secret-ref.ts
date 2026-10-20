// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

const environmentSecretRef = /^env:[A-Za-z_]\w*$/;
const fileSecretRef = /^file:\/[^\0\r\n]+$/;
const keyVaultSecretRef =
  /^akv:[a-zA-Z][a-zA-Z0-9-]{2,23}\/[a-zA-Z0-9-]{1,127}(?:#[a-zA-Z0-9-]{1,64})?$/u;

/** A reference to a secret stored outside the harness configuration. */
export const SecretRefSchema = z
  .string()
  .refine(
    (value) =>
      environmentSecretRef.test(value) ||
      fileSecretRef.test(value) ||
      keyVaultSecretRef.test(value),
    { error: "secret_ref_invalid" },
  )
  .brand<"SecretRef">();

/** A validated environment, file, or Azure Key Vault secret reference. */
export type SecretRef = z.infer<typeof SecretRefSchema>;
