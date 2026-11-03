// SPDX-License-Identifier: Apache-2.0
import {
  JsonValue,
  McpResultArtifactReferenceSchema,
  McpToolResultEnvelopeSchema,
  type Code,
  type JsonValue as JsonValueType,
} from "@rovinos/schemas";
import { OffloadedHandleSchema } from "./offload-schemas.js";
import type { OffloadedHandle } from "./offload-schemas.js";
import type {
  OffloadIdGenerator,
  OffloadToolExecutionResult,
  WorkspacePort,
} from "./offload.js";

interface PreparedArtifactBatch {
  readonly handles: readonly OffloadedHandle[];
  readonly sizes: readonly number[];
  readonly result: JsonValueType;
  readonly writes: readonly { readonly path: string; readonly data: Uint8Array }[];
}

type Preparation = { readonly errorCode: Code } | PreparedArtifactBatch;

function toolError(errorCode: Code): OffloadToolExecutionResult {
  return { outcome: "error", errorCode, result: null };
}

function isRecord(value: JsonValueType): value is Record<string, JsonValueType> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function replacedPart(
  part: JsonValueType | undefined,
  target: "data" | "resource.blob",
  reference: JsonValueType,
): JsonValueType | undefined {
  if (!isRecord(part)) {
    return undefined;
  }
  if (target === "data") {
    const remaining = { ...part };
    Reflect.deleteProperty(remaining, "data");
    return { ...remaining, artifact: reference };
  }
  if (!isRecord(part.resource)) {
    return undefined;
  }
  const remainingResource = { ...part.resource };
  Reflect.deleteProperty(remainingResource, "blob");
  return {
    ...part,
    resource: { ...remainingResource, artifact: reference },
  };
}

function prepareArtifactBatch(
  execution: OffloadToolExecutionResult,
  ids: OffloadIdGenerator,
): Preparation {
  const envelope = McpToolResultEnvelopeSchema.safeParse(execution.result);
  if (!envelope.success || execution.artifacts === undefined) {
    return { errorCode: "mcp_result_invalid" };
  }
  const parts = [...envelope.data.parts];
  const handles: OffloadedHandle[] = [];
  const sizes: number[] = [];
  const writes: { readonly path: string; readonly data: Uint8Array }[] = [];
  for (const artifact of execution.artifacts) {
    const handle = OffloadedHandleSchema.safeParse(`wf_${ids.next()}`);
    const reference = McpResultArtifactReferenceSchema.safeParse({
      handle: handle.success ? handle.data : undefined,
      mimeType: artifact.mimeType,
      bytes: artifact.bytes.byteLength,
      sha256: artifact.sha256,
    });
    const part = parts[artifact.partIndex];
    if (!handle.success || !reference.success || part === undefined) {
      return { errorCode: "mcp_result_invalid" };
    }
    const nextPart = replacedPart(part, artifact.target, JsonValue.parse(reference.data));
    if (nextPart === undefined) {
      return { errorCode: "mcp_result_invalid" };
    }
    parts[artifact.partIndex] = nextPart;
    handles.push(handle.data);
    sizes.push(artifact.bytes.byteLength);
    writes.push({
      path: `.harness/offload/${handle.data}.bin`,
      data: artifact.bytes,
    });
  }

  const result = JsonValue.parse({ ...envelope.data, parts });
  const resultLimitBytes = execution.resultLimitBytes;
  if (
    resultLimitBytes !== undefined &&
    Buffer.byteLength(JSON.stringify(result), "utf8") > resultLimitBytes
  ) {
    return { errorCode: "result_too_large" };
  }
  return { handles, sizes, result, writes };
}

/** Replaces binary data with references and publishes the files as one workspace batch. */
export async function offloadArtifactResult(
  execution: OffloadToolExecutionResult,
  workspace: WorkspacePort,
  ids: OffloadIdGenerator,
  knownSizes: Map<OffloadedHandle, number>,
): Promise<OffloadToolExecutionResult> {
  const prepared = prepareArtifactBatch(execution, ids);
  if ("errorCode" in prepared) {
    return toolError(prepared.errorCode);
  }
  try {
    await workspace.writeBatch(prepared.writes);
  } catch {
    return toolError("artifact_write_failed");
  }
  for (const [index, handle] of prepared.handles.entries()) {
    const size = prepared.sizes[index];
    if (size !== undefined) {
      knownSizes.set(handle, size);
    }
  }
  return {
    outcome: execution.outcome,
    ...(execution.errorCode === undefined ? {} : { errorCode: execution.errorCode }),
    result: prepared.result,
  };
}
