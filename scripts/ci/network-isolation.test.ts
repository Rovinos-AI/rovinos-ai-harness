// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { parseYaml } from "@harness/schemas";
import { z } from "zod";

const root = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const serviceSchema = z.object({
  extends: z.object({ file: z.string(), service: z.string() }).optional(),
  networks: z.union([z.array(z.string()), z.record(z.string(), z.unknown())]).optional(),
});
const composeSchema = z.object({
  networks: z.record(z.string(), z.object({ internal: z.boolean().optional() })),
  services: z.record(z.string(), serviceSchema),
});

type ComposeService = z.infer<typeof serviceSchema>;

function networkNames(service: ComposeService): string[] {
  return Array.isArray(service.networks) ? service.networks : Object.keys(service.networks ?? {});
}

function resolvedNetworkNames(
  service: ComposeService,
  baseServices: Record<string, ComposeService>,
): string[] {
  const extended = service.extends ? baseServices[service.extends.service] : undefined;
  return [
    ...new Set([...(extended ? networkNames(extended) : []), ...networkNames(service)]),
  ].sort();
}

it("limits Compose egress to the collector and keeps Postgres host-publishable", () => {
  const base = parseYaml(
    composeSchema,
    readFileSync(resolve(root, "infra/compose/docker-compose.yml"), "utf8"),
  );
  const test = parseYaml(
    composeSchema,
    readFileSync(resolve(root, "infra/compose/docker-compose.test.yml"), "utf8"),
  );
  const serviceNetworks = Object.fromEntries(
    Object.entries(test.services).map(([name, service]) => [
      name,
      resolvedNetworkNames(service, base.services),
    ]),
  );

  expect(base.networks.internal?.internal).toBe(true);
  expect(test.networks.internal?.internal).toBe(true);
  expect(test.networks.egress?.internal).not.toBe(true);
  expect(test.networks["test-host"]?.internal).not.toBe(true);
  expect(test.services.harness?.extends).toEqual({
    file: "docker-compose.yml",
    service: "harness",
  });
  expect(test.services["otel-collector"]?.extends).toEqual({
    file: "docker-compose.yml",
    service: "otel-collector",
  });
  expect(serviceNetworks.harness).toEqual(["internal"]);
  expect(serviceNetworks["otel-collector"]).toEqual(["egress", "internal"]);
  expect(serviceNetworks.postgres).toEqual(["test-host"]);
  expect(
    Object.entries(serviceNetworks)
      .filter(([, networks]) => networks.includes("egress"))
      .map(([name]) => name),
  ).toEqual(["otel-collector"]);
});
