// SPDX-License-Identifier: Apache-2.0
import { randomBytes } from "node:crypto";
import { isIP } from "node:net";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  Client,
  KustoConnectionStringBuilder,
  kustoTrustedEndpoints,
  MatchRule,
} from "azure-kusto-data";
import { applySchemaFile, type KustoManagementClient } from "./apply-schema.ts";

const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

interface Fixture {
  readonly table: string;
  readonly mapping: string;
  readonly row: Readonly<Record<string, unknown>>;
}

function createDatabaseName(): string {
  const timestamp = BigInt(Date.now());
  const randomness = BigInt(`0x${randomBytes(10).toString("hex")}`);
  let value = (timestamp << 80n) | randomness;
  let ulid = "";
  for (let index = 0; index < 26; index += 1) {
    const character = alphabet[Number(value & 31n)];
    if (character === undefined) {
      throw new TypeError("invalid_ulid_character");
    }
    ulid = character + ulid;
    value >>= 5n;
  }
  return `h_${ulid}`;
}

function createClient(clusterUri: string): Client {
  const endpoint = new URL(clusterUri);
  if (endpoint.protocol !== "http:" || isIP(endpoint.hostname) !== 4) {
    throw new TypeError("kusto_emulator_endpoint_invalid");
  }
  kustoTrustedEndpoints.addTrustedHosts([new MatchRule(endpoint.hostname, true)], false);
  return new Client(
    new KustoConnectionStringBuilder(
      `Data Source=${clusterUri};Initial Catalog=NetDefaultDB;AAD Federated Security=False`,
    ),
  );
}

function createManagementClient(client: Client): KustoManagementClient {
  return {
    executeMgmt: async (database, command) => client.executeMgmt(database, command),
  };
}

function createFixtures(timestamp: string): readonly Fixture[] {
  return [
    {
      table: "HarnessTraces",
      mapping: "HarnessTracesMapping",
      row: {
        TraceID: "0123456789abcdef0123456789abcdef",
        SpanID: "0123456789abcdef",
        ParentID: "",
        SpanName: "harness.test",
        SpanStatus: "Ok",
        SpanKind: "Internal",
        StartTime: timestamp,
        EndTime: timestamp,
        ResourceAttributes: { "service.name": "harness-test" },
        TraceAttributes: { "harness.safe.event": "test" },
        Events: [],
        Links: [],
        SpanStatusMessage: "",
      },
    },
    {
      table: "HarnessLogs",
      mapping: "HarnessLogsMapping",
      row: {
        Timestamp: timestamp,
        ObservedTimestamp: timestamp,
        TraceID: "0123456789abcdef0123456789abcdef",
        SpanID: "0123456789abcdef",
        SeverityText: "INFO",
        SeverityNumber: 9,
        Body: "synthetic safe event",
        ResourceAttributes: { "service.name": "harness-test" },
        LogsAttributes: { "harness.safe.event": "test" },
      },
    },
    {
      table: "HarnessMetrics",
      mapping: "HarnessMetricsMapping",
      row: {
        Timestamp: timestamp,
        MetricName: "harness.test.counter",
        MetricType: "Sum",
        MetricUnit: "1",
        MetricDescription: "Synthetic test counter",
        MetricValue: 1,
        Host: "test-host",
        ResourceAttributes: { "service.name": "harness-test" },
        MetricAttributes: { "harness.execution.outcome": "completed" },
      },
    },
  ];
}

function databaseCount(response: Awaited<ReturnType<Client["executeQuery"]>>): number {
  const value: unknown = response.primaryResults[0]?.rows().next().value?.getValueAt(0);
  if (typeof value !== "number") {
    throw new TypeError("kusto_count_result_missing");
  }
  return value;
}

async function createDatabase(client: Client, database: string): Promise<void> {
  const databasePath = `/kustodata/dbs/${database}`;
  await client.executeMgmt(
    null,
    `.create database ${database} persist (@"${databasePath}/md", @"${databasePath}/data")`,
  );
}

async function applySchema(client: Client, database: string): Promise<void> {
  const managementClient = createManagementClient(client);
  await applySchemaFile(managementClient, database);
  await applySchemaFile(managementClient, database);
}

async function ingestFixtures(
  client: Client,
  database: string,
  fixtures: readonly Fixture[],
): Promise<void> {
  for (const fixture of fixtures) {
    await client.executeMgmt(
      database,
      `.ingest inline into table ${fixture.table} with (format='json', ingestionMappingReference='${fixture.mapping}') <| ${JSON.stringify(fixture.row)}`,
    );
    const response = await client.executeQuery(database, `${fixture.table} | count`);
    if (databaseCount(response) !== 1) {
      throw new Error("kusto_fixture_count_mismatch");
    }
  }
}

async function dropDatabase(client: Client, database: string): Promise<void> {
  await client.executeMgmt(database, `.drop database ${database} ifexists`).catch(() => undefined);
}

async function runContract(clusterUri: string): Promise<void> {
  const database = createDatabaseName();
  const client = createClient(clusterUri);
  let databaseCreated = false;
  try {
    await client.executeMgmt(null, ".show cluster");
    await createDatabase(client, database);
    databaseCreated = true;
    await applySchema(client, database);
    await ingestFixtures(client, database, createFixtures(new Date().toISOString()));
    process.stdout.write("kusto_emulator_contract_passed\n");
  } catch {
    process.stderr.write("kusto_emulator_contract_failed\n");
    process.exitCode = 1;
  } finally {
    if (databaseCreated) {
      await dropDatabase(client, database);
    }
    client.close();
  }
}

async function main(): Promise<void> {
  const clusterUri = process.env.KUSTO_CLUSTER_URI;
  if (
    process.argv.slice(2).length !== 1 ||
    process.argv[2] !== "--run" ||
    clusterUri === undefined
  ) {
    process.stderr.write("kusto_emulator_contract_configuration_invalid\n");
    process.exitCode = 1;
    return;
  }
  await runContract(clusterUri);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main();
}
