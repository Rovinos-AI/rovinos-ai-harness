// SPDX-License-Identifier: Apache-2.0
// Mount only the socket file into a trial. Its containing directory remains host-private.
import { chmod, mkdtemp, rm } from "node:fs/promises";
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { resolve as resolvePath } from "node:path";
import type { Socket } from "node:net";
import type { ModelPort } from "@rovinos/core";
import { compileJsonSchema, JsonValue, parseJson } from "@rovinos/schemas";
import { schemaHash, toJsonSchema } from "@rovinos/models";
import { z } from "zod";
import {
  LIVE_MODEL_MAX_BYTES,
  LiveModelCompletionSchema,
  LiveModelError,
  LiveModelReplySchema,
  LiveModelRequestSchema,
  liveModelFailure,
} from "./live-model-contract.js";

async function body(message: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const value of message) {
    const chunk: unknown = value;
    if (!Buffer.isBuffer(chunk)) {
      throw new LiveModelError("eval_live_request_invalid");
    }
    bytes += chunk.length;
    if (bytes > LIVE_MODEL_MAX_BYTES) {
      throw new LiveModelError("eval_live_request_invalid");
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Private host gateway. Rejections are retained only as a bounded metadata count. */
export interface LiveModelGateway {
  readonly socketPath: string;
  readonly rejections: number;
  close(): Promise<void>;
}

function send(response: ServerResponse, payload: z.infer<typeof LiveModelReplySchema>): void {
  if (response.destroyed) {
    return;
  }
  const text = JSON.stringify(payload);
  if (Buffer.byteLength(text) > LIVE_MODEL_MAX_BYTES) {
    throw new LiveModelError("eval_live_response_invalid");
  }
  response.writeHead(payload.ok ? 200 : 400, {
    "content-type": "application/json",
    connection: "close",
  });
  response.end(text);
}

function outputSchema(
  output: NonNullable<z.infer<typeof LiveModelRequestSchema>["request"]["output"]>,
): z.ZodType {
  try {
    const json = z.union([z.boolean(), z.record(z.string(), JsonValue)]).parse(output.schema);
    const validate = compileJsonSchema(json);
    return z.fromJSONSchema(json).superRefine((value, context) => {
      try {
        validate(value);
      } catch {
        context.addIssue({ code: "custom", message: "eval_live_response_invalid" });
      }
    });
  } catch {
    throw new LiveModelError("eval_live_request_invalid");
  }
}

function gatewayServer(sessionModel: ModelPort, lifetime: AbortSignal, reject: () => void) {
  return createServer({ maxHeaderSize: 8_192 }, (request, response) => {
    const controller = new AbortController();
    const abort = () => {
      controller.abort();
    };
    request.once("aborted", abort);
    response.once("close", abort);
    const signal = AbortSignal.any([controller.signal, lifetime]);
    void (async () => {
      try {
        if (
          request.method !== "POST" ||
          request.url !== "/complete" ||
          request.headers["content-type"] !== "application/json" ||
          request.headers["content-encoding"] !== undefined
        ) {
          throw new LiveModelError("eval_live_request_invalid");
        }
        let input: z.infer<typeof LiveModelRequestSchema>;
        try {
          input = parseJson(LiveModelRequestSchema, await body(request), {
            maxBytes: LIVE_MODEL_MAX_BYTES,
          });
        } catch {
          throw new LiveModelError("eval_live_request_invalid");
        }
        if (signal.aborted) {
          throw new LiveModelError("eval_live_cancelled");
        }
        const completion = await sessionModel.complete(input.request, {
          runId: input.runId,
          signal,
          ...(input.deadlineTs === undefined ? {} : { deadlineTs: input.deadlineTs }),
          ...(input.request.output === undefined
            ? {}
            : { outputSchema: outputSchema(input.request.output) }),
        });
        const parsed = LiveModelCompletionSchema.safeParse(completion);
        if (!parsed.success) {
          throw new LiveModelError("eval_live_response_invalid");
        }
        send(response, { ok: true, completion: parsed.data });
      } catch (error) {
        reject();
        send(response, { ok: false, code: liveModelFailure(error) });
      } finally {
        request.removeListener("aborted", abort);
        response.removeListener("close", abort);
      }
    })().catch(() => response.destroy());
  });
}

/**
 * Serves bounded POST /complete messages over a private Unix socket, never TCP.
 * The socket is writable by container UID 65532; the 0700 parent is not mounted.
 */
export async function startLiveModelGateway(
  sessionModel: ModelPort,
  options: { readonly signal?: AbortSignal } = {},
): Promise<LiveModelGateway> {
  if (options.signal?.aborted === true) {
    throw new LiveModelError("eval_live_cancelled");
  }
  let directory: string;
  try {
    directory = await mkdtemp(resolvePath(".live-model-"));
  } catch {
    throw new LiveModelError("eval_live_transport_failed");
  }
  const socketPath = resolvePath(directory, "model.sock");
  const lifetime = new AbortController();
  const sockets = new Set<Socket>();
  let rejections = 0;
  const server = gatewayServer(sessionModel, lifetime.signal, () => {
    rejections = Math.min(Number.MAX_SAFE_INTEGER, rejections + 1);
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  let closing: Promise<void> | undefined;
  const abortGateway = () => {
    void close().catch(() => undefined);
  };
  function close(): Promise<void> {
    closing ??= (async () => {
      options.signal?.removeEventListener("abort", abortGateway);
      lifetime.abort();
      const stopped = new Promise<void>((resolve) =>
        server.close(() => {
          resolve();
        }),
      );
      for (const socket of sockets) {
        socket.destroy();
      }
      await stopped;
      await rm(directory, { recursive: true, force: true });
    })().catch(() => {
      throw new LiveModelError("eval_live_transport_failed");
    });
    return closing;
  }
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    server.on("error", () => {
      void close().catch(() => undefined);
    });
    await chmod(socketPath, 0o666);
    options.signal?.addEventListener("abort", abortGateway, { once: true });
    if (Boolean(options.signal?.aborted)) {
      await close();
      throw new LiveModelError("eval_live_cancelled");
    }
    return {
      socketPath,
      get rejections() {
        return rejections;
      },
      close,
    };
  } catch (error) {
    await close();
    throw error instanceof LiveModelError
      ? error
      : new LiveModelError("eval_live_transport_failed");
  }
}

function encodeRequest(
  request: Parameters<ModelPort["complete"]>[0],
  context: Parameters<ModelPort["complete"]>[1],
): string {
  // A value transform can depend on the trial vault and cannot execute on the host.
  if (context.valueTransform !== undefined) {
    throw new LiveModelError("eval_live_request_invalid");
  }
  const schema =
    context.outputSchema === undefined ? undefined : toJsonSchema(context.outputSchema);
  const input = LiveModelRequestSchema.safeParse({
    request:
      schema === undefined
        ? request
        : {
            ...request,
            output: {
              name: request.output?.name ?? "result",
              schema,
              schemaHash: schemaHash(schema),
            },
          },
    runId: context.runId,
    ...(context.deadlineTs === undefined ? {} : { deadlineTs: context.deadlineTs }),
  });
  if (!input.success) {
    throw new LiveModelError("eval_live_request_invalid");
  }
  const text = JSON.stringify(input.data);
  if (Buffer.byteLength(text) > LIVE_MODEL_MAX_BYTES) {
    throw new LiveModelError("eval_live_request_invalid");
  }
  return text;
}

/**
 * Creates a credential-free ModelPort for a socket mounted into a trial.
 * Only the fixed RPC path is used; disconnects and caller aborts cancel host work.
 */
export function createLiveModelClient(socketPath: string): ModelPort {
  if (
    !z
      .string()
      .min(1)
      .max(4_096)
      .refine((value) => !value.includes("\0"))
      .safeParse(socketPath).success
  ) {
    throw new LiveModelError("eval_live_config_invalid");
  }
  return {
    async complete(request, context) {
      try {
        if (context.signal.aborted) {
          throw new LiveModelError("eval_live_cancelled");
        }
        const text = encodeRequest(request, context);
        const reply = await new Promise<z.infer<typeof LiveModelReplySchema>>((resolve, reject) => {
          const call = httpRequest(
            {
              socketPath,
              path: "/complete",
              method: "POST",
              signal: context.signal,
              headers: {
                "content-type": "application/json",
                "content-length": Buffer.byteLength(text),
              },
            },
            (response) => {
              void body(response)
                .then((value) => {
                  resolve(
                    parseJson(LiveModelReplySchema, value, { maxBytes: LIVE_MODEL_MAX_BYTES }),
                  );
                })
                .catch(reject);
            },
          );
          call.once("error", () => {
            reject(
              new LiveModelError(
                context.signal.aborted ? "eval_live_cancelled" : "eval_live_transport_failed",
              ),
            );
          });
          call.end(text);
        });
        if (!reply.ok) {
          throw new LiveModelError(reply.code);
        }
        return reply.completion;
      } catch (error) {
        throw error instanceof LiveModelError
          ? error
          : new LiveModelError("eval_live_transport_failed");
      }
    },
  };
}
