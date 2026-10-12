// SPDX-License-Identifier: Apache-2.0
import type { HostConfig } from "@harness/schemas";
import { z } from "zod";

const RESOURCE_MIME_TYPE = "text/html;profile=mcp-app";
const MAX_RESOURCE_BYTES = 1_048_576;

const ResourceContentsSchema = z
  .object({
    mimeType: z.string().optional(),
    text: z.string().optional(),
    _meta: z.record(z.string(), z.unknown()).optional(),
  })
  .loose();
export const ResourceReadSchema = z
  .object({ contents: z.array(ResourceContentsSchema).min(1) })
  .loose();
const CspSchema = z
  .object({
    connectDomains: z.array(z.string()).optional(),
    resourceDomains: z.array(z.string()).optional(),
    frameDomains: z.array(z.string()).optional(),
    baseUriDomains: z.array(z.string()).optional(),
  })
  .loose();
const UiMetadataSchema = z
  .object({
    csp: CspSchema.optional(),
    permissions: z.record(z.string(), z.unknown()).optional(),
  })
  .loose();
const ResourceMetadataSchema = z.object({ ui: UiMetadataSchema.optional() }).loose();

/** Contents returned by the connected MCP client's resources/read operation. */
export type AppResourceRead = z.infer<typeof ResourceReadSchema>;

/** Safe host diagnostic codes emitted for policy decisions. */
export type HostDiagnosticCode = "app_csp_request_ignored";

/** The non-network policy applied to app resources before insertion into iframe srcdoc. */
export const REFERENCE_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'";

const PERMISSION_FEATURES: Readonly<Record<string, string>> = {
  camera: "camera",
  microphone: "microphone",
  geolocation: "geolocation",
  clipboardWrite: "clipboard-write",
};

/** Resource HTML and the host-filtered policy values sent to the browser. */
export interface ValidatedResource {
  readonly html: string;
  readonly csp: string;
  readonly permissions: readonly string[];
}

function metadataUi(content: z.infer<typeof ResourceContentsSchema>): {
  readonly csp: z.infer<typeof CspSchema> | undefined;
  readonly permissions: Record<string, unknown>;
} {
  const metadata = ResourceMetadataSchema.safeParse(content._meta);
  if (!metadata.success || metadata.data.ui === undefined) {
    return { csp: undefined, permissions: {} };
  }
  return {
    csp: metadata.data.ui.csp,
    permissions: metadata.data.ui.permissions ?? {},
  };
}

function allowedDomains(
  requested: readonly string[] | undefined,
  allowlist: readonly string[],
  onCode: (code: HostDiagnosticCode) => void,
): readonly string[] {
  const allowed = new Set(allowlist.map((entry) => new URL(entry).origin));
  const filtered: string[] = [];
  for (const domain of requested ?? []) {
    let origin: string | undefined;
    try {
      origin = new URL(domain).origin;
    } catch {
      origin = undefined;
    }
    if (origin !== undefined && allowed.has(origin)) {
      filtered.push(origin);
    } else {
      onCode("app_csp_request_ignored");
    }
  }
  return filtered;
}

function buildCsp(
  csp: z.infer<typeof CspSchema> | undefined,
  allowlist: readonly string[],
  onCode: (code: HostDiagnosticCode) => void,
): string {
  if (csp === undefined) {
    return REFERENCE_CSP;
  }
  const connect = allowedDomains(csp.connectDomains, allowlist, onCode);
  const resources = allowedDomains(csp.resourceDomains, allowlist, onCode);
  const frames = allowedDomains(csp.frameDomains, allowlist, onCode);
  const bases = allowedDomains(csp.baseUriDomains, allowlist, onCode);
  const directives = [
    "default-src 'none'",
    `script-src 'unsafe-inline'${resources.length === 0 ? "" : ` ${resources.join(" ")}`}`,
    `style-src 'unsafe-inline'${resources.length === 0 ? "" : ` ${resources.join(" ")}`}`,
    `img-src data:${resources.length === 0 ? "" : ` ${resources.join(" ")}`}`,
    `font-src data:${resources.length === 0 ? "" : ` ${resources.join(" ")}`}`,
    `connect-src ${connect.length === 0 ? "'none'" : connect.join(" ")}`,
    `frame-src ${frames.length === 0 ? "'none'" : frames.join(" ")}`,
    `base-uri ${bases.length === 0 ? "'none'" : bases.join(" ")}`,
    ...(resources.length === 0 ? [] : [`media-src data: ${resources.join(" ")}`]),
    "form-action 'none'",
  ];
  return directives.join("; ");
}

/** Reads and filters an app resource against the host's CSP and permission policies. */
export async function readValidatedResource(
  resourceUri: string,
  config: HostConfig,
  readResource: (resourceUri: string) => Promise<unknown>,
  onCode: (code: HostDiagnosticCode) => void,
): Promise<ValidatedResource | undefined> {
  const result = ResourceReadSchema.safeParse(await readResource(resourceUri));
  if (!result.success) {
    return undefined;
  }
  const content = result.data.contents[0];
  if (content?.mimeType !== RESOURCE_MIME_TYPE || content.text === undefined) {
    return undefined;
  }
  if (Buffer.byteLength(content.text, "utf8") > MAX_RESOURCE_BYTES) {
    return undefined;
  }
  const metadata = metadataUi(content);
  const permissions = Object.keys(metadata.permissions)
    .filter(
      (permission) =>
        config.permissionAllowlist.some((allowedPermission) => allowedPermission === permission) &&
        PERMISSION_FEATURES[permission] !== undefined,
    )
    .map((permission) => PERMISSION_FEATURES[permission])
    .filter((permission) => permission !== undefined);
  return {
    html: content.text,
    csp: buildCsp(metadata.csp, config.cspAllowlist, onCode),
    permissions,
  };
}
