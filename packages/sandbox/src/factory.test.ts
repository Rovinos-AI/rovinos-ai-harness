// SPDX-License-Identifier: Apache-2.0
import { Id, SandboxConfigSchema, SecretRefSchema } from "@harness/schemas";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSandboxBackend, InProcessBackend, RemoteSandboxBackend } from "./index.js";

const deps = { workspaceRoot: process.cwd(), logger: { log: vi.fn() } };
const runner = {
  url: "http://sandbox-runner:8080",
  token: SecretRefSchema.parse("env:SANDBOX_TOKEN"),
};
const token = "synthetic-factory-runner-token-0001";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("createSandboxBackend", () => {
  it("uses the local backend without resolving secrets or calling the network", async () => {
    const fetcher = vi.fn();
    const resolve = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const backend = await createSandboxBackend(undefined, { ...deps, secretResolver: { resolve } });

    expect(backend).toBeInstanceOf(InProcessBackend);
    await expect(
      backend.exec(
        Id.parse("00000000000000000000000001"),
        {
          argv: [process.execPath, "-e", ""],
          timeoutMs: 2000,
          limits: { memoryMb: 128, pids: 16, outputBytes: 1024, cpuSeconds: 5 },
        },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ exitCode: 0 });
    expect(resolve).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("resolves the runner SecretRef once and authenticates remote execution", async () => {
    const resolve = vi.fn(() => Promise.resolve({ reveal: () => token }));
    const result = {
      exitCode: 0,
      stdout: "",
      stderr: "",
      stdoutBytes: 0,
      stderrBytes: 0,
      truncated: false,
      timedOut: false,
      durationMs: 1,
    };
    const fetcher = vi.fn<typeof fetch>(() => Promise.resolve(Response.json(result)));
    vi.stubGlobal("fetch", fetcher);
    const backend = await createSandboxBackend(SandboxConfigSchema.parse({ runner }), {
      ...deps,
      secretResolver: { resolve },
    });
    expect(backend).toBeInstanceOf(RemoteSandboxBackend);
    expect(resolve).toHaveBeenCalledExactlyOnceWith(runner.token);
    await backend.exec(
      Id.parse("00000000000000000000000001"),
      {
        argv: ["node", "-e", ""],
        timeoutMs: 2000,
        limits: { memoryMb: 128, pids: 16, outputBytes: 1024, cpuSeconds: 5 },
      },
      new AbortController().signal,
    );
    expect(fetcher.mock.calls[0]?.[0]).toEqual(new URL("/exec", runner.url));
    expect(fetcher.mock.calls[0]?.[1]?.headers).toMatchObject({
      authorization: ["Bearer", token].join(" "),
    });
    expect(JSON.stringify(backend)).not.toContain(token);
  });

  // threat: T-03
  it("preserves the production refusal unless the unsafe local opt-in is explicit", async () => {
    vi.stubEnv("NODE_ENV", "production");
    await expect(createSandboxBackend({}, deps)).rejects.toMatchObject({
      code: "sandbox_inprocess_production",
    });
    await expect(
      createSandboxBackend({ allowUnsafeInProcess: true }, deps),
    ).resolves.toBeInstanceOf(InProcessBackend);
  });

  // threat: T-05
  it("refuses to emulate configured egress on the host", async () => {
    await expect(
      createSandboxBackend(
        { egress: { allow: [{ host: "api.example.com", ports: [443] }] } },
        deps,
      ),
    ).rejects.toMatchObject({ code: "sandbox_runner_config_invalid" });
  });

  it("accepts a remote runner paired with configured egress", async () => {
    await expect(
      createSandboxBackend(
        SandboxConfigSchema.parse({
          runner,
          egress: { allow: [{ host: "api.example.com", ports: [443] }] },
        }),
        { ...deps, secretResolver: { resolve: () => Promise.resolve({ reveal: () => token }) } },
      ),
    ).resolves.toBeInstanceOf(RemoteSandboxBackend);
  });

  // threat: T-10
  it.each(["missing", "rejected", "invalid", "reveal"] as const)(
    "fails closed without exposing a secret when resolution is %s",
    async (scenario) => {
      const canary = "synthetic-secret-canary";
      const secretResolver =
        scenario === "missing"
          ? undefined
          : {
              resolve: () =>
                scenario === "rejected"
                  ? Promise.reject(new Error(canary))
                  : Promise.resolve({
                      reveal: () => {
                        if (scenario === "reveal") {
                          throw new Error(canary);
                        }
                        return canary;
                      },
                    }),
            };
      const error: unknown = await createSandboxBackend(SandboxConfigSchema.parse({ runner }), {
        ...deps,
        ...(secretResolver === undefined ? {} : { secretResolver }),
      }).catch((caught: unknown) => caught);
      expect(error).toMatchObject({ code: "sandbox_runner_config_invalid" });
      expect(String(error)).not.toContain(canary);
      expect(JSON.stringify(error)).not.toContain(canary);
    },
  );

  it("rejects invalid runner configuration before resolving secrets", async () => {
    const resolve = vi.fn();
    await expect(
      createSandboxBackend(
        { runner: { ...runner, url: "http://runner/?raw=canary" } },
        {
          ...deps,
          secretResolver: { resolve },
        },
      ),
    ).rejects.toMatchObject({ code: "sandbox_runner_config_invalid" });
    expect(resolve).not.toHaveBeenCalled();
  });
});
