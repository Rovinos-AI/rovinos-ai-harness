// SPDX-License-Identifier: Apache-2.0
import { fileURLToPath } from "node:url";
import { AuditingVaultResolver } from "@rovinos/vault";
import { EventSchema, Id } from "@rovinos/schemas";
import type { Event } from "@rovinos/schemas";
import { describe, expect, it } from "vitest";
import type { GradeContext } from "./types.js";
import { completedTrialResult } from "../../test-utils/trial-result.js";
import { createSchemaValidGrader } from "./schema-valid.js";

const runId = Id.parse("00000000000000000000000001");
const answerSchemaRef = `${fileURLToPath(new URL("./schema-fixture.ts", import.meta.url))}#AnswerSchema`;
const tokenSchemaRef = `${fileURLToPath(new URL("./schema-fixture.ts", import.meta.url))}#TokenizedAnswerSchema`;
const throwingSchemaRef = `${fileURLToPath(new URL("./schema-fixture.ts", import.meta.url))}#ThrowingSchema`;

function response(seq: number, text: string): Event {
  return EventSchema.parse({
    runId,
    seq,
    ts: seq,
    v: 1,
    traceId: "00000000000000000000000000000001",
    spanId: "0000000000000001",
    segmentId: runId,
    type: "model_response",
    requestId: Id.parse("00000000000000000000000002"),
    provider: "synthetic",
    model: "synthetic",
    inputTokens: 0,
    outputTokens: 0,
    finishReason: "stop",
    latencyMs: 0,
    schemaValid: true,
    repairAttempts: 0,
    content: [{ type: "text", text }],
    providerBlobs: null,
  });
}

function emptyResponse(seq: number): Event {
  return EventSchema.parse({
    runId,
    seq,
    ts: seq,
    v: 1,
    traceId: "00000000000000000000000000000001",
    spanId: "0000000000000001",
    segmentId: runId,
    type: "model_response",
    requestId: Id.parse("00000000000000000000000002"),
    provider: "synthetic",
    model: "synthetic",
    inputTokens: 0,
    outputTokens: 0,
    finishReason: "tool_calls",
    latencyMs: 0,
    schemaValid: true,
    repairAttempts: 0,
    content: [],
    providerBlobs: null,
  });
}

function context(events: readonly Event[]): GradeContext {
  return {
    result: completedTrialResult({
      runId,
    }),
    events,
  };
}

describe("createSchemaValidGrader", () => {
  it("extracts JSON from the final model response and validates it", async () => {
    await expect(
      createSchemaValidGrader({
        type: "schema_valid",
        schemaRef: answerSchemaRef,
      }).grade(
        context([
          response(1, '{"answer":3}'),
          response(2, 'Result: ```json\n{"answer":"ok"}\n```'),
          emptyResponse(3),
        ]),
      ),
    ).resolves.toMatchObject({ pass: true, score: 1, codes: [] });
  });

  it("reports missing JSON and schema mismatches without exposing output", async () => {
    const canary = "synthetic-response-canary-23";
    const noJson = await createSchemaValidGrader({
      type: "schema_valid",
      schemaRef: answerSchemaRef,
    }).grade(context([response(1, canary)]));
    const invalid = await createSchemaValidGrader({
      type: "schema_valid",
      schemaRef: answerSchemaRef,
    }).grade(context([response(1, `{"answer": "${canary}", "extra": true}`)]));

    expect(noJson).toMatchObject({ pass: false, codes: ["no_json"] });
    expect(invalid).toMatchObject({ pass: false, codes: ["schema_invalid"] });
    expect(JSON.stringify([noJson, invalid])).not.toContain(canary);
  });

  it("returns metadata codes for empty text, unavailable schemas, and validation exceptions", async () => {
    const emptyText = await createSchemaValidGrader({
      type: "schema_valid",
      schemaRef: answerSchemaRef,
    }).grade(context([emptyResponse(1)]));
    const schemaFile = fileURLToPath(new URL("./schema-fixture.ts", import.meta.url));
    const missingExport = await createSchemaValidGrader({
      type: "schema_valid",
      schemaRef: `${schemaFile}#MissingSchema`,
    }).grade(context([response(1, '{"answer":"ok"}')]));
    const invalidRef = await createSchemaValidGrader({
      type: "schema_valid",
      schemaRef: "#",
    }).grade(context([response(1, '{"answer":"ok"}')]));
    const missingModule = await createSchemaValidGrader({
      type: "schema_valid",
      schemaRef: `${schemaFile}.missing#Schema`,
    }).grade(context([response(1, '{"answer":"ok"}')]));
    const thrownValidation = await createSchemaValidGrader({
      type: "schema_valid",
      schemaRef: throwingSchemaRef,
    }).grade(context([response(1, '{"answer":"value"}')]));

    expect(emptyText).toMatchObject({ pass: false, codes: ["no_json"] });
    expect(missingExport).toMatchObject({ pass: false, codes: ["schema_invalid"] });
    expect(invalidRef).toMatchObject({ pass: false, codes: ["schema_invalid"] });
    expect(missingModule).toMatchObject({ pass: false, codes: ["schema_invalid"] });
    expect(thrownValidation).toMatchObject({ pass: false, codes: ["schema_invalid"] });
  });

  it("accepts tokenized output through audited validation when configured", async () => {
    const resolver = new AuditingVaultResolver(
      {
        resolve: () => Promise.resolve("synthetic@example.test"),
      },
      () => undefined,
    );
    const result = await createSchemaValidGrader({
      type: "schema_valid",
      schemaRef: tokenSchemaRef,
    }).grade({
      ...context([response(1, '{"email":"<EMAIL_1>"}')]),
      tokenValidation: { resolver },
    });

    expect(result).toMatchObject({ pass: true, score: 1, codes: [] });
  });
});
