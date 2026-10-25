// SPDX-License-Identifier: Apache-2.0
import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import type {
  BedrockRuntimeClientConfig,
  ConverseCommandInput,
  ConverseResponse,
} from "@aws-sdk/client-bedrock-runtime";
import {
  lookupCapabilities,
  type Capabilities,
  type Code,
  type ModelRequest,
} from "@rovinos/schemas";
import { mapBedrockError } from "./bedrock-errors.js";
import {
  buildMessages,
  createToolNameMapping,
  mappedToolName,
  type ToolNameMapping,
} from "./bedrock-messages.js";
import { mapBedrockResponse } from "./bedrock-response.js";
import { ProviderError } from "../errors.js";
import type { ProviderAdapter, ProviderContext, ProviderResult } from "../types.js";

/** Credentials used by tests; production callers should omit this to use the AWS default chain. */
export interface BedrockCredentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken?: string;
}

/** Configuration for an Amazon Bedrock Converse adapter. */
export interface BedrockAdapterOptions {
  /** AWS region for the Bedrock Runtime client. */
  readonly region: string;
  /** Maps normalized model codes to Bedrock model IDs or inference profile IDs. */
  readonly modelIds: Readonly<Record<string, string>>;
  /** Configured provider code used to identify opaque response parts. */
  readonly provider?: Code;
  /** Default maximum response-token count. */
  readonly maxOutputTokens?: number;
  /** Optional provider capability overrides used by the gateway's enforcement ladder. */
  readonly capabilities?: Partial<Capabilities>;
  /** Optional HTTP handler for tests; omitted in production. */
  readonly requestHandler?: BedrockRuntimeClientConfig["requestHandler"];
  /** Optional test credential provider; production should use the AWS default chain. */
  readonly credentialsProvider?: () => Promise<BedrockCredentials>;
}

function buildToolConfig(
  request: ModelRequest,
  toolNames: ToolNameMapping,
): ConverseCommandInput["toolConfig"] {
  const toolChoice = request.toolChoice;
  if (toolChoice === "none" || request.tools === undefined || request.tools.length === 0) {
    if (toolChoice === "required" || typeof toolChoice === "object") {
      throw new ProviderError("provider_bad_request");
    }
    return undefined;
  }
  const tools = request.tools.map((tool) => ({
    toolSpec: {
      name: mappedToolName(tool.toolId, toolNames),
      description: tool.description,
      inputSchema: { json: tool.inputSchema },
    },
  }));
  if (toolChoice === "auto") {
    return { tools, toolChoice: { auto: {} } };
  }
  if (toolChoice === "required") {
    return { tools, toolChoice: { any: {} } };
  }
  if (typeof toolChoice === "object") {
    if (!request.tools.some((tool) => tool.toolId === toolChoice.forced)) {
      throw new ProviderError("provider_bad_request");
    }
    return {
      tools,
      toolChoice: { tool: { name: mappedToolName(toolChoice.forced, toolNames) } },
    };
  }
  return { tools };
}

function buildSystem(request: ModelRequest) {
  return request.messages.flatMap((message) =>
    message.role === "system"
      ? message.parts.flatMap((part) => (part.type === "text" ? [{ text: part.text }] : []))
      : [],
  );
}

interface BedrockRequestOptions {
  readonly provider: Code;
  readonly maxOutputTokens: number;
  readonly capabilities: Capabilities;
  readonly toolNames: ToolNameMapping;
}

function buildRequest(
  request: ModelRequest,
  modelId: string,
  options: BedrockRequestOptions,
): ConverseCommandInput {
  const toolConfig = buildToolConfig(request, options.toolNames);
  const system = buildSystem(request);
  return {
    modelId,
    messages: buildMessages(request, options.provider, options.toolNames),
    inferenceConfig: {
      maxTokens: request.maxOutputTokens ?? options.maxOutputTokens,
      ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
    },
    ...(system.length === 0 ? {} : { system }),
    ...(toolConfig === undefined ? {} : { toolConfig }),
    ...(request.output === undefined || options.capabilities.structuredOutput !== "native"
      ? {}
      : {
          outputConfig: {
            textFormat: {
              type: "json_schema",
              structure: {
                jsonSchema: {
                  name: request.output.name,
                  schema: JSON.stringify(request.output.schema),
                },
              },
            },
          },
        }),
  };
}

/** Amazon Bedrock Converse adapter with provider-specific content preserved for rehydration. */
export class BedrockAdapter implements ProviderAdapter {
  readonly provider: Code;
  readonly kind = "bedrock" as const;
  readonly maxOutputTokens: number;
  readonly capabilities: Partial<Capabilities>;
  private readonly client: BedrockRuntimeClient;
  private readonly modelIds: Readonly<Record<string, string>>;

  /**
   * Creates a Converse adapter with AWS SDK retries disabled.
   *
   * @param options - Region, configured model IDs, and optional test transport dependencies.
   */
  constructor(options: BedrockAdapterOptions) {
    this.provider = options.provider ?? "bedrock";
    this.maxOutputTokens = options.maxOutputTokens ?? 4_096;
    this.capabilities = options.capabilities ?? {};
    this.modelIds = options.modelIds;
    this.client = new BedrockRuntimeClient({
      region: options.region,
      maxAttempts: 1,
      ...(options.requestHandler === undefined ? {} : { requestHandler: options.requestHandler }),
      ...(options.credentialsProvider === undefined
        ? {}
        : { credentials: options.credentialsProvider }),
    });
  }

  /** @inheritdoc */
  async complete(request: ModelRequest, context: ProviderContext): Promise<ProviderResult> {
    const startedAt = context.clock.now();
    const modelId = this.modelIds[request.model.model];
    if (modelId === undefined) {
      throw new ProviderError("provider_bad_request");
    }
    const capabilities = lookupCapabilities(
      { ...request.model, provider: this.kind },
      this.capabilities,
    ).capabilities;
    const toolNames = createToolNameMapping(request, this.provider);
    const command = new ConverseCommand(
      buildRequest(request, modelId, {
        provider: this.provider,
        maxOutputTokens: this.maxOutputTokens,
        capabilities,
        toolNames,
      }),
    );
    let response: ConverseResponse;
    try {
      response = await this.client.send(command, { abortSignal: context.signal });
    } catch (error) {
      throw mapBedrockError(error, context.signal);
    }
    try {
      return mapBedrockResponse(response, context, {
        provider: this.provider,
        startedAt,
        toolNames,
      });
    } catch (error) {
      throw error instanceof ProviderError ? error : new ProviderError("provider_unknown");
    }
  }
}
