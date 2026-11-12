// SPDX-License-Identifier: Apache-2.0
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client, KustoConnectionStringBuilder } from "azure-kusto-data";

/** Minimal Kusto management client contract used by the schema applier. */
export interface KustoManagementClient {
  executeMgmt(database: string | null, command: string): Promise<unknown>;
}

/** Splits KQL commands separated by one or more blank lines. */
export function splitKustoCommands(schema: string): string[] {
  return schema
    .replace(/^\/\/ SPDX-License-Identifier: Apache-2\.0\r?\n/u, "")
    .split(/\r?\n\s*\r?\n/u)
    .map((command) => command.trim())
    .filter((command) => command.length > 0);
}

/** Applies each non-empty KQL command in order and propagates client failures. */
export async function applySchema(
  client: KustoManagementClient,
  database: string,
  schema: string,
): Promise<void> {
  for (const command of splitKustoCommands(schema)) {
    await client.executeMgmt(database, command);
  }
}

/** Reads and applies the repository Kusto schema file. */
export async function applySchemaFile(
  client: KustoManagementClient,
  database: string,
): Promise<void> {
  const schema = await readFile(new URL("../../infra/kusto/schema.kql", import.meta.url), "utf8");
  await applySchema(client, database, schema);
}

function createConnectionString(
  clusterUri: string,
  emulator: boolean,
): KustoConnectionStringBuilder {
  const endpoint = new URL(clusterUri);
  if (emulator) {
    if (
      endpoint.protocol !== "http:" ||
      !["localhost", "127.0.0.1", "::1"].includes(endpoint.hostname)
    ) {
      throw new Error("invalid_emulator_endpoint");
    }
    return new KustoConnectionStringBuilder(
      `Data Source=${clusterUri};AAD Federated Security=False`,
    );
  }
  if (endpoint.protocol !== "https:") {
    throw new Error("https_required");
  }

  const managedIdentityId = process.env.ADX_MANAGED_IDENTITY_ID;
  if (managedIdentityId === "system") {
    return KustoConnectionStringBuilder.withSystemManagedIdentity(clusterUri);
  }
  if (managedIdentityId !== undefined && managedIdentityId.length > 0) {
    return KustoConnectionStringBuilder.withUserManagedIdentity(clusterUri, managedIdentityId);
  }

  const applicationId = process.env.ADX_APPLICATION_ID;
  const applicationKey = process.env.ADX_APPLICATION_KEY;
  const tenantId = process.env.ADX_TENANT_ID;
  if (
    applicationId !== undefined &&
    applicationKey !== undefined &&
    tenantId !== undefined &&
    applicationId.length > 0 &&
    applicationKey.length > 0 &&
    tenantId.length > 0
  ) {
    return KustoConnectionStringBuilder.withAadApplicationKeyAuthentication(
      clusterUri,
      applicationId,
      applicationKey,
      tenantId,
    );
  }
  throw new Error("kusto_authentication_missing");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const emulator = args.includes("--emulator");
  if (!args.includes("--apply") || args.some((arg) => !["--apply", "--emulator"].includes(arg))) {
    throw new Error("explicit_apply_flag_required");
  }
  const database = process.env.ADX_DATABASE;
  const clusterUri = process.env.ADX_CLUSTER_URI ?? (emulator ? "http://127.0.0.1:8080" : undefined);
  if (database === undefined || database.length === 0 || clusterUri === undefined) {
    throw new Error("kusto_configuration_missing");
  }

  const client = new Client(createConnectionString(clusterUri, emulator));
  try {
    await applySchemaFile(client, database);
  } finally {
    client.close();
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch(() => {
    process.stderr.write("kusto_schema_apply_failed\n");
    process.exitCode = 1;
  });
}
