// SPDX-License-Identifier: Apache-2.0
import { parseJson, type OAuthDiscoveryConfig } from "@rovinos/schemas";
import { z } from "zod";
import {
  createOAuthDiscoveryOperation,
  readOAuthDiscoveryBody,
  requestOAuthDiscovery,
} from "./discovery-transport.js";
import type { OAuthDiscoveryTransportDependencies } from "./discovery-transport.js";

export const OAUTH_CLIENT_CREDENTIALS_EXTENSION =
  "io.modelcontextprotocol/oauth-client-credentials";

const ProtectedResourceMetadataSchema = z.looseObject({
  extensions: z.record(z.string(), z.unknown()).optional(),
});

function metadataAdvertisesClientCredentials(text: string): boolean {
  try {
    const metadata = parseJson(ProtectedResourceMetadataSchema, text);
    return metadata.extensions?.[OAUTH_CLIENT_CREDENTIALS_EXTENSION] !== undefined;
  } catch {
    return false;
  }
}

function resourceMetadataHint(
  headers: Readonly<Record<string, string | string[] | undefined>>,
): string | undefined {
  const rawHeader = headers["www-authenticate"];
  const header = Array.isArray(rawHeader) ? rawHeader.join(", ") : rawHeader;
  return header?.match(/(?:^|,|\s)\s*resource_metadata\s*=\s*"([^"]+)"/iu)?.[1];
}

/** Reads an explicitly advertised MCP extension before an OAuth retry on initialize. */
export async function resourceAdvertisesClientCredentials(
  serverUrl: string,
  signal?: AbortSignal,
  policy: OAuthDiscoveryConfig = { profile: "production" },
  dependencies: OAuthDiscoveryTransportDependencies = {},
): Promise<boolean> {
  const operation = createOAuthDiscoveryOperation(signal);
  try {
    const resourceUrl = new URL(serverUrl);
    const challenge = await requestOAuthDiscovery(resourceUrl, policy, operation, dependencies);
    if (challenge === undefined) {
      return false;
    }
    const metadataUrlText =
      challenge.status === 401 ? resourceMetadataHint(challenge.headers) : undefined;
    challenge.body.destroy();
    let metadataUrl: URL;
    try {
      metadataUrl =
        metadataUrlText === undefined
          ? new URL(
              `/.well-known/oauth-protected-resource${resourceUrl.pathname}`,
              resourceUrl.origin,
            )
          : new URL(metadataUrlText, resourceUrl);
    } catch {
      return false;
    }
    const response = await requestOAuthDiscovery(metadataUrl, policy, operation, dependencies);
    if (response === undefined) {
      return false;
    }
    if (response.status >= 500) {
      response.body.destroy();
      throw new Error("protected_resource_probe_failed");
    }
    if (response.status < 200 || response.status >= 300) {
      response.body.destroy();
      return false;
    }
    return metadataAdvertisesClientCredentials(
      await readOAuthDiscoveryBody(response.body, operation),
    );
  } catch (error) {
    operation.throwIfAborted();
    if (error instanceof Error && error.message === "protected_resource_probe_failed") {
      throw error;
    }
    throw new Error("protected_resource_probe_failed");
  } finally {
    operation.cleanup();
  }
}
