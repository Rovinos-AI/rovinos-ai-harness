// SPDX-License-Identifier: Apache-2.0
import { UriTemplate, type Client } from "@modelcontextprotocol/client";
import { Code, type ServerConfig } from "@rovinos/schemas";
import { z } from "zod";
import { McpConnectionError } from "./errors.js";
import { abortable, decodedBytes } from "./discovery-budget.js";
import {
  createTimedSignal,
  resourceDiscoverySlots,
  resourceReadSlots,
} from "./resource-semaphore.js";

const MAX_RESOURCE_PAGES = 100;
const MAX_RESOURCES = 1_000;
const MAX_DISCOVERY_BYTES = 8_388_608;
const MAX_RESOURCE_REQUEST_BYTES = 4_194_304;
const RESOURCE_DISCOVERY_TIMEOUT_MS = 30_000;
const ResourceUriListSchema = z.array(z.string().min(1).max(2_048)).max(MAX_RESOURCES);

type ResourceGrant = NonNullable<ServerConfig["resourceUriGrants"]>[number];

interface CompiledGrant {
  readonly id: Code;
  readonly matches: (uri: string) => boolean;
}

/** Tokenizes one untrusted resource string at the host's model-input PII boundary. */
export type ResourceTextTokenizer = (text: string, signal: AbortSignal) => Promise<string>;

/** Options shared by public resource operations. */
export interface ResourceOperationOptions {
  readonly signal?: AbortSignal;
  readonly tokenizeText: ResourceTextTokenizer;
}

/** Safe provenance attached to every listed or read resource. */
export interface McpResourceProvenance {
  readonly serverId: Code;
  readonly grantId: Code;
}

/** Tokenized metadata for one explicitly granted resource. */
export interface McpResource {
  readonly uri: string;
  readonly name: string;
  readonly description?: string;
  readonly mimeType?: string;
  readonly provenance: McpResourceProvenance;
}

/** Tokenized text returned from one explicitly granted resource. */
export interface McpResourceRead {
  readonly contents: readonly {
    readonly text: string;
    readonly mimeType?: string;
  }[];
  readonly provenance: McpResourceProvenance;
}

/** Internal per-operation context required for safe provenance and invalidation. */
export interface ResourceAccessOptions extends ResourceOperationOptions {
  readonly serverId: Code;
  readonly assertGeneration?: () => void;
}

/** Per-read limits and timeouts enforced by the resource access boundary. */
interface ResourceReadOptions extends ResourceAccessOptions {
  readonly maxResultBytes: number;
  readonly callTimeoutMs: number;
}

interface ResourcePageCollectionOptions {
  readonly findGrant: (uri: string) => Code | undefined;
  readonly options: ResourceAccessOptions;
  readonly signal: AbortSignal;
  readonly timeoutSignal: AbortSignal;
}

interface ResourceReadContext {
  readonly client: Client;
  readonly uri: string;
  readonly grant: Code;
  readonly options: ResourceReadOptions;
  readonly signal: AbortSignal;
  readonly budget: ResourceReadBudget;
  readonly controller: AbortController;
}

class ResourceReadBudget {
  #decodedBytes = 0;
  #tokenizedBytes = 0;

  add(decodedResponseBytes: number, tokenizedBytes: number): void {
    this.#decodedBytes += decodedResponseBytes;
    this.#tokenizedBytes += tokenizedBytes;
    if (
      this.#decodedBytes > MAX_RESOURCE_REQUEST_BYTES ||
      this.#tokenizedBytes > MAX_RESOURCE_REQUEST_BYTES
    ) {
      throw new McpConnectionError("mcp_resource_request_too_large");
    }
  }
}

function grantId(index: number): Code {
  return Code.parse(`resource_grant_${String(index)}`);
}

/** Compiles the configured per-server URI grants and performs only exact/local matching. */
export class ResourceUriAccess {
  readonly #grants: readonly CompiledGrant[];

  constructor(grants: readonly ResourceGrant[] | undefined) {
    try {
      this.#grants = (grants ?? []).map((grant, index) => {
        const id = grantId(index);
        if (grant.kind === "uri") {
          return { id, matches: (uri) => uri === grant.uri };
        }
        const template = new UriTemplate(grant.uriTemplate);
        return { id, matches: (uri) => template.match(uri) !== null };
      });
    } catch {
      throw new McpConnectionError("mcp_resource_grant_invalid");
    }
  }

  /** Whether this server has at least one configured resource grant. */
  get hasGrants(): boolean {
    return this.#grants.length > 0;
  }

  /** Returns the matching opaque grant id without exposing configured URI strings. */
  findGrant(uri: string): Code | undefined {
    return this.#grants.find((grant) => grant.matches(uri))?.id;
  }

  /** Validates and authorizes every URI before the caller connects or sends a request. */
  authorize(uris: readonly string[]): readonly string[] {
    const parsedUris = ResourceUriListSchema.safeParse(uris);
    if (!parsedUris.success) {
      throw new McpConnectionError("mcp_resource_uri_invalid");
    }
    if (parsedUris.data.some((uri) => this.findGrant(uri) === undefined)) {
      throw new McpConnectionError("mcp_resource_access_denied");
    }
    return parsedUris.data;
  }

  /** Lists only resources covered by a grant, with all server-provided strings tokenized. */
  async list(client: Client, options: ResourceAccessOptions): Promise<McpResource[]> {
    if (!this.hasGrants) {
      throw new McpConnectionError("mcp_resource_access_denied");
    }
    return listGrantedResources(client, (uri) => this.findGrant(uri), options);
  }

  /** Reads a complete request batch and returns nothing if any read or budget check fails. */
  async read(
    client: Client,
    uris: readonly string[],
    options: ResourceReadOptions,
  ): Promise<McpResourceRead[]> {
    const parsedUris = ResourceUriListSchema.safeParse(uris);
    if (!parsedUris.success) {
      throw new McpConnectionError("mcp_resource_uri_invalid");
    }
    if (parsedUris.data.length === 0) {
      return [];
    }
    const grants = parsedUris.data.map((uri) => this.findGrant(uri));
    if (grants.some((grant) => grant === undefined)) {
      throw new McpConnectionError("mcp_resource_access_denied");
    }
    return readGrantedResources(client, parsedUris.data, grants, options);
  }
}

async function listGrantedResources(
  client: Client,
  findGrant: (uri: string) => Code | undefined,
  options: ResourceAccessOptions,
): Promise<McpResource[]> {
  const operation = createTimedSignal(options.signal, RESOURCE_DISCOVERY_TIMEOUT_MS);
  try {
    return await resourceDiscoverySlots.run(operation.signal, () =>
      collectResourcePages(client, {
        findGrant,
        options,
        signal: operation.signal,
        timeoutSignal: operation.timeout.signal,
      }),
    );
  } catch (error) {
    if (operation.timeout.signal.aborted) {
      throw new McpConnectionError("mcp_discovery_timeout");
    }
    if (operation.signal.aborted) {
      throw new McpConnectionError("mcp_discovery_cancelled");
    }
    if (error instanceof McpConnectionError) {
      throw error;
    }
    throw new McpConnectionError("mcp_list_resources_failed");
  } finally {
    clearTimeout(operation.timer);
  }
}

async function collectResourcePages(
  client: Client,
  context: ResourcePageCollectionOptions,
): Promise<McpResource[]> {
  const { findGrant, options, signal, timeoutSignal } = context;
  const resources: McpResource[] = [];
  const cursors = new Set<string>();
  // An explicit cursor selects the SDK's single-page path instead of its auto-aggregator.
  let cursor: string | undefined = "";
  let pages = 0;
  let observed = 0;
  let bytes = 0;
  do {
    assertActive(signal, timeoutSignal, options.assertGeneration);
    if (pages >= MAX_RESOURCE_PAGES) {
      throw new McpConnectionError("mcp_discovery_page_limit");
    }
    const page = await abortable(
      () => client.listResources({ cursor }, { signal, cacheMode: "bypass" }),
      signal,
    );
    pages++;
    observed += page.resources.length;
    if (observed > MAX_RESOURCES) {
      throw new McpConnectionError("mcp_too_many_resources");
    }
    bytes += decodedBytes(page, MAX_DISCOVERY_BYTES - bytes, "mcp_discovery_data_limit", signal);
    for (const resource of page.resources) {
      const metadata = await tokenizeResourceMetadata(resource, findGrant, options, signal);
      if (metadata !== undefined) {
        resources.push(metadata);
      }
    }
    cursor = page.nextCursor;
    if (cursor === "") {
      cursor = undefined;
    } else if (cursor !== undefined) {
      if (cursors.has(cursor)) {
        throw new McpConnectionError("mcp_list_resources_failed");
      }
      cursors.add(cursor);
    }
    assertActive(signal, timeoutSignal, options.assertGeneration);
  } while (cursor !== undefined);
  return resources;
}

async function tokenizeResourceMetadata(
  resource: Awaited<ReturnType<Client["listResources"]>>["resources"][number],
  findGrant: (uri: string) => Code | undefined,
  options: ResourceAccessOptions,
  signal: AbortSignal,
): Promise<McpResource | undefined> {
  const matchedGrant = findGrant(resource.uri);
  if (matchedGrant === undefined) {
    return undefined;
  }
  return {
    uri: await tokenize(options.tokenizeText, resource.uri, signal),
    name: await tokenize(options.tokenizeText, resource.name, signal),
    ...(resource.description === undefined
      ? {}
      : { description: await tokenize(options.tokenizeText, resource.description, signal) }),
    ...(resource.mimeType === undefined
      ? {}
      : { mimeType: await tokenize(options.tokenizeText, resource.mimeType, signal) }),
    provenance: { serverId: options.serverId, grantId: matchedGrant },
  };
}

async function readGrantedResources(
  client: Client,
  uris: readonly string[],
  grants: readonly (Code | undefined)[],
  options: ResourceReadOptions,
): Promise<McpResourceRead[]> {
  const controller = new AbortController();
  const signal = AbortSignal.any([
    controller.signal,
    ...(options.signal === undefined ? [] : [options.signal]),
  ]);
  const budget = new ResourceReadBudget();
  try {
    return await Promise.all(
      uris.map(async (uri, index) => {
        const currentGrant = grants[index];
        if (currentGrant === undefined) {
          throw new McpConnectionError("mcp_resource_access_denied");
        }
        return readOneResource({
          client,
          uri,
          grant: currentGrant,
          options,
          signal,
          budget,
          controller,
        });
      }),
    );
  } catch (error) {
    controller.abort();
    if (options.signal?.aborted === true) {
      throw new McpConnectionError("mcp_discovery_cancelled");
    }
    if (error instanceof McpConnectionError) {
      throw error;
    }
    throw new McpConnectionError("mcp_read_resource_failed");
  }
}

async function readOneResource(context: ResourceReadContext): Promise<McpResourceRead> {
  const { client, uri, grant, options, signal, budget, controller } = context;
  return resourceReadSlots.run(signal, async () => {
    assertActive(signal, undefined, options.assertGeneration);
    const timeout = createTimedSignal(signal, options.callTimeoutMs);
    try {
      const response = await abortable(
        () => client.readResource({ uri }, { signal: timeout.signal, cacheMode: "bypass" }),
        timeout.signal,
      );
      const responseBytes = decodedBytes(
        response,
        options.maxResultBytes,
        "mcp_response_too_large",
        timeout.signal,
      );
      const contents = await tokenizeResourceContents(response, options, timeout.signal);
      budget.add(responseBytes, contents.tokenizedBytes);
      assertActive(signal, undefined, options.assertGeneration);
      return {
        contents: contents.values,
        provenance: { serverId: options.serverId, grantId: grant },
      };
    } catch (error) {
      const timedOut = timeout.timeout.signal.aborted;
      const callerCancelled = options.signal?.aborted === true;
      controller.abort();
      if (timedOut && !callerCancelled) {
        throw new McpConnectionError("mcp_resource_timeout");
      }
      if (error instanceof McpConnectionError) {
        throw error;
      }
      throw new McpConnectionError("mcp_read_resource_failed");
    } finally {
      clearTimeout(timeout.timer);
    }
  });
}

async function tokenizeResourceContents(
  response: Awaited<ReturnType<Client["readResource"]>>,
  options: ResourceReadOptions,
  signal: AbortSignal,
): Promise<{
  readonly values: McpResourceRead["contents"][number][];
  readonly tokenizedBytes: number;
}> {
  const values: McpResourceRead["contents"][number][] = [];
  let tokenizedBytes = 0;
  for (const content of response.contents) {
    if (!("text" in content)) {
      throw new McpConnectionError("mcp_resource_content_unsupported");
    }
    const text = await tokenize(options.tokenizeText, content.text, signal);
    tokenizedBytes += Buffer.byteLength(text, "utf8");
    values.push({
      text,
      ...(content.mimeType === undefined
        ? {}
        : { mimeType: await tokenize(options.tokenizeText, content.mimeType, signal) }),
    });
  }
  return { values, tokenizedBytes };
}

async function tokenize(
  tokenizer: ResourceTextTokenizer,
  text: string,
  signal: AbortSignal,
): Promise<string> {
  assertActive(signal);
  let tokenized: string;
  try {
    tokenized = await tokenizer(text, signal);
  } catch {
    throw new McpConnectionError("mcp_resource_tokenization_failed");
  }
  if (typeof tokenized !== "string") {
    throw new McpConnectionError("mcp_resource_tokenization_failed");
  }
  assertActive(signal);
  return tokenized;
}

function assertActive(
  signal: AbortSignal,
  timeoutSignal?: AbortSignal,
  assertGeneration?: () => void,
): void {
  if (timeoutSignal?.aborted === true) {
    throw new McpConnectionError("mcp_discovery_timeout");
  }
  if (signal.aborted) {
    throw new McpConnectionError("mcp_discovery_cancelled");
  }
  assertGeneration?.();
}
