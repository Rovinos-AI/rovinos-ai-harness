// SPDX-License-Identifier: Apache-2.0
import { parseJson } from "@harness/schemas";
import { z } from "zod";

export const OAUTH_CLIENT_CREDENTIALS_EXTENSION =
  "io.modelcontextprotocol/oauth-client-credentials";

const ProtectedResourceMetadataSchema = z.looseObject({
  extensions: z.record(z.string(), z.unknown()).optional(),
});

/** Reads an explicitly advertised MCP extension before an OAuth retry on initialize. */
export async function resourceAdvertisesClientCredentials(
  serverUrl: string,
  signal?: AbortSignal,
): Promise<boolean> {
  try {
    const resourceUrl = new URL(serverUrl);
    const challenge = await fetch(resourceUrl, {
      headers: { accept: "application/json" },
      redirect: "error",
      ...(signal === undefined ? {} : { signal }),
    });
    const resourceMetadata =
      challenge.status === 401
        ? challenge.headers
            .get("www-authenticate")
            ?.match(/(?:^|,|\s)\s*resource_metadata\s*=\s*"([^"]+)"/iu)?.[1]
        : undefined;
    await challenge.body?.cancel();
    const metadataUrl =
      resourceMetadata === undefined
        ? new URL(
            `/.well-known/oauth-protected-resource${resourceUrl.pathname}`,
            resourceUrl.origin,
          )
        : new URL(resourceMetadata);
    if (
      !["http:", "https:"].includes(metadataUrl.protocol) ||
      metadataUrl.username !== "" ||
      metadataUrl.password !== ""
    ) {
      return false;
    }
    const response = await fetch(metadataUrl, {
      headers: { accept: "application/json" },
      redirect: "error",
      ...(signal === undefined ? {} : { signal }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      return false;
    }
    const metadata = parseJson(ProtectedResourceMetadataSchema, await response.text());
    return metadata.extensions?.[OAUTH_CLIENT_CREDENTIALS_EXTENSION] !== undefined;
  } catch {
    return false;
  }
}
