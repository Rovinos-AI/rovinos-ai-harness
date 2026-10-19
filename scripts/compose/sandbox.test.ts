// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { createSandboxComposeInvocation } from "./sandbox.js";

describe("sandbox Compose configuration", () => {
  it("adds the egress profile and serializes the config allowlist", () => {
    const allow = [{ host: "api.example.test", ports: [443] }];
    const environment = { SANDBOX_RUNNER_TOKEN: "synthetic-compose-token" };
    const invocation = createSandboxComposeInvocation(
      { allow },
      ["up", "sandbox-runner"],
      environment,
    );

    expect(invocation.args).toContain("sandbox-egress");
    expect(invocation.args).toContain("infra/compose/docker-compose.egress.yml");
    expect(invocation.args).toContain("dev");
    expect(invocation.args).toContain("infra/compose/docker-compose.dev.yml");
    expect(invocation.env.SANDBOX_EGRESS_ALLOW).toBe(JSON.stringify(allow));
    expect(invocation.env.SANDBOX_RUNNER_TOKEN).toBe("synthetic-compose-token");
    expect(environment).not.toHaveProperty("SANDBOX_EGRESS_ALLOW");
  });

  it("omits the egress profile and stale proxy environment without an allowlist", () => {
    const invocation = createSandboxComposeInvocation({ allow: [] }, ["config"], {
      SANDBOX_EGRESS_ALLOW: "stale",
      SANDBOX_EGRESS_PROXY_URL: "http://stale-proxy:3128",
    });

    expect(invocation.args).not.toContain("sandbox-egress");
    expect(invocation.args).not.toContain("infra/compose/docker-compose.egress.yml");
    expect(invocation.args).toContain("infra/compose/docker-compose.dev.yml");
    expect(invocation.env.SANDBOX_EGRESS_ALLOW).toBeUndefined();
    expect(invocation.env.SANDBOX_EGRESS_PROXY_URL).toBeUndefined();
  });
});
