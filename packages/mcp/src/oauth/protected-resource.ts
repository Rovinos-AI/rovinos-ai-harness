// SPDX-License-Identifier: Apache-2.0
import { parseJson } from "@rovinos/schemas";
import { z } from "zod";

export const OAUTH_CLIENT_CREDENTIALS_EXTENSION =
  "io.modelcontextprotocol/oauth-client-credentials";

const ProtectedResourceMetadataSchema = z.looseObject({
  extensions: z.record(z.string(), z.unknown()).optional(),
});

function isSafeMetadataUrl(url: URL): boolean {
  return ["http:", "https:"].includes(url.protocol) && url.username === "" && url.password === "";
}

function metadataAdvertisesClientCredentials(text: string): boolean {
  try {
    const metadata = parseJson(ProtectedResourceMetadataSchema, text);
    return metadata.extensions?.[OAUTH_CLIENT_CREDENTIALS_EXTENSION] !== undefined;
  } catch {
    return false;
  }
}

/** Reads an explicitly advertised MCP extension before an OAuth retry on initialize. */
export async function resourceAdvertisesClientCredentials(
  serverUrl: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const resourceUrl = new URL(serverUrl);
  const challenge = await fetch(resourceUrl, {
    credentials: "omit",
    headers: { accept: "application/json" },
    redirect: "follow",
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
      ? new URL(`/.well-known/oauth-protected-resource${resourceUrl.pathname}`, resourceUrl.origin)
      : new URL(resourceMetadata);
  if (!isSafeMetadataUrl(metadataUrl)) {
    return false;
  }
  const response = await fetch(metadataUrl, {
    credentials: "omit",
    headers: { accept: "application/json" },
    redirect: "follow",
    ...(signal === undefined ? {} : { signal }),
  });
  if (response.status >= 500) {
    await response.body?.cancel();
    throw new Error("protected_resource_probe_failed");
  }
  if (!response.ok) {
    await response.body?.cancel();
    return false;
  }
  return metadataAdvertisesClientCredentials(await response.text());
}
