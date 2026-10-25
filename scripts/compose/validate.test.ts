// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseYaml, RunConfigSchema } from "@rovinos/schemas";
import { evaluateComposeSecurity, validateComposeProfiles } from "./validate.js";
import { z } from "zod";

const root = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const composeSchema = z.object({ services: z.record(z.string(), z.unknown()) });
const serviceSchema = z.object({ healthcheck: z.unknown(), environment: z.unknown() });
const healthcheckSchema = z.looseObject({ start_period: z.string(), test: z.array(z.string()) });
const documentedPresidioStartPeriodMs = 300_000;

function service(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    cap_drop: ["ALL"],
    security_opt: ["no-new-privileges:true"],
    read_only: true,
    tmpfs: ["/tmp:size=64m,noexec,nosuid,nodev"],
    networks: ["internal"],
    healthcheck: { test: ["CMD", "node", "dist/bin.js", "healthcheck"] },
    ...overrides,
  };
}

function durationMilliseconds(duration: string): number {
  const match = /^(\d+(?:\.\d+)?)(ms|[smh])$/u.exec(duration);
  if (match === null) {
    return 0;
  }

  const amount = Number(match[1]);
  const unit = match[2];
  const multipliers: Readonly<Record<string, number>> = {
    ms: 1,
    s: 1_000,
    m: 60_000,
    h: 3_600_000,
  };
  return amount * (unit === undefined ? 0 : (multipliers[unit] ?? 0));
}

function config(services: Record<string, Record<string, unknown>>) {
  return {
    services,
    networks: {
      internal: { internal: true },
      egress: {},
      "test-host": {},
    },
  };
}

describe("compose security evaluator", () => {
  it("keeps the Presidio startup grace at or above its documented minimum", () => {
    const compose = parseYaml(
      composeSchema,
      readFileSync(resolve(root, "infra/compose/docker-compose.yml"), "utf8"),
    );
    const presidioService = serviceSchema.parse(compose.services["presidio-analyzer"]);
    const healthcheck = healthcheckSchema.parse(presidioService.healthcheck);

    expect(durationMilliseconds(healthcheck.start_period)).toBeGreaterThanOrEqual(
      documentedPresidioStartPeriodMs,
    );
    expect(healthcheck.test.join(" ")).toContain("http://127.0.0.1:3000/health");
    expect(presidioService.environment).toMatchObject({ GUNICORN_CMD_ARGS: "--no-control-socket" });
  });

  it.each([
    ["privileged containers", { privileged: true }, "privileged"],
    [
      "docker socket bind mounts",
      { volumes: ["/var/run/docker.sock:/var/run/docker.sock"] },
      "docker_socket_mount",
    ],
    ["missing capability drops", { cap_drop: ["NET_ADMIN"] }, "cap_drop_all_missing"],
    ["missing no-new-privileges", { security_opt: [] }, "no_new_privileges_missing"],
    ["writable root filesystems", { read_only: false }, "read_only_missing"],
    ["missing writable tmpfs", { tmpfs: [] }, "tmpfs_missing"],
    ["tmpfs without hardened options", { tmpfs: ["/tmp"] }, "tmpfs_options_missing"],
    [
      "tmpfs with executable mounts",
      { tmpfs: ["/tmp:size=64m,nosuid,nodev"] },
      "tmpfs_options_missing",
    ],
    ["missing healthchecks", { healthcheck: undefined }, "healthcheck_missing"],
    ["disabled healthchecks", { healthcheck: { test: ["NONE"] } }, "healthcheck_missing"],
    [
      "disabled healthcheck flags",
      { healthcheck: { test: ["CMD", "true"], disable: true } },
      "healthcheck_missing",
    ],
    ["empty healthcheck tests", { healthcheck: { test: [""] } }, "healthcheck_missing"],
    ["host networking", { network_mode: "host" }, "host_network"],
    [
      "literal secret environment values",
      { environment: { API_TOKEN: "literal" } },
      "literal_secret_environment",
    ],
    [
      "literal runner token environment values",
      { environment: { SANDBOX_RUNNER_TOKEN: "synthetic-token" } },
      "literal_secret_environment",
    ],
  ])("rejects %s", (_label, overrides, expectedCode) => {
    expect(evaluateComposeSecurity(config({ harness: service(overrides) }), "dev")).toContain(
      `harness: ${expectedCode}`,
    );
  });

  it("rejects services attached to an external network", () => {
    expect(
      evaluateComposeSecurity(config({ harness: service({ networks: ["egress"] }) }), "dev"),
    ).toContain("harness: external_network");
  });

  it.each(["dev", "test", "prod-like"] as const)(
    "rejects a published Presidio port in the %s profile",
    (profile) => {
      expect(
        evaluateComposeSecurity(
          config({ "presidio-analyzer": service({ ports: ["3000:3000"] }) }),
          profile,
        ),
      ).toContain("presidio-analyzer: published_ports");
    },
  );

  it("rejects published Presidio ports in every rendered Compose profile", () => {
    expect(
      validateComposeProfiles().filter((violation) =>
        violation.endsWith("presidio-analyzer: published_ports"),
      ),
    ).toEqual([]);
  }, 20_000);

  it("permits the collector and the test-only published database network", () => {
    expect(
      evaluateComposeSecurity(
        config({
          "otel-collector": { networks: ["egress"] },
          postgres: service({ networks: ["test-host"] }),
        }),
        "test",
      ),
    ).toEqual([]);
  });

  it.each([
    ["cpu_limit_missing", { mem_limit: "1g" }],
    ["memory_limit_missing", { cpus: 1 }],
    ["restart_policy_invalid", { cpus: 1, mem_limit: "1g", restart: "always" }],
    [
      "stop_signal_invalid",
      { cpus: 1, mem_limit: "1g", restart: "unless-stopped", stop_signal: "SIGINT" },
    ],
  ])("rejects prod-like config missing %s", (expectedCode, overrides) => {
    expect(evaluateComposeSecurity(config({ harness: service(overrides) }), "prod-like")).toContain(
      `harness: ${expectedCode}`,
    );
  });

  it("rejects a stop grace period exactly at the configured floor", () => {
    const floor = RunConfigSchema.parse({}).shutdownGraceMs + 5_000;
    expect(
      evaluateComposeSecurity(
        config({
          harness: service({
            cpus: 1,
            mem_limit: "1g",
            restart: "unless-stopped",
            stop_signal: "SIGTERM",
            stop_grace_period: `${String(floor)}ms`,
          }),
        }),
        "prod-like",
      ),
    ).toContain("harness: stop_grace_period_too_short");
  });

  it("accepts a runner token file reference without accepting a literal token", () => {
    expect(
      evaluateComposeSecurity(
        config({
          "sandbox-runner": service({
            environment: { SANDBOX_RUNNER_TOKEN_FILE: "/run/secrets/sandbox_runner_token" },
          }),
        }),
        "dev",
      ),
    ).toEqual([]);
  });

  it("accepts a hardened prod-like service with a sufficient stop grace period", () => {
    expect(
      evaluateComposeSecurity(
        config({
          harness: service({
            cpus: 1,
            mem_limit: "1g",
            restart: "unless-stopped",
            stop_signal: "SIGTERM",
            stop_grace_period: "30s",
          }),
        }),
        "prod-like",
      ),
    ).toEqual([]);
  });
});
