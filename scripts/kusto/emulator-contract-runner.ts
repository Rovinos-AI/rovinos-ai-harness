// SPDX-License-Identifier: Apache-2.0
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deepStrictEqual } from "node:assert/strict";
import {
  Client,
  KustoConnectionStringBuilder,
  kustoTrustedEndpoints,
  MatchRule,
} from "azure-kusto-data";
import { applySchemaFile, type KustoManagementClient } from "./apply-schema.ts";
import {
  assertKustoQueryGoldens,
  kustoQueryNames,
  parseKustoLogFixtures,
  parseKustoQueryRows,
  parseKustoQueryGoldens,
  type KustoLogFixture,
} from "./query-contract.ts";

const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const emulatorDatabase = "NetDefaultDB";
const contractModes = ["--run", "--queries"] as const;

type ConfigurationErrorCode =
  | "invalid_arguments"
  | "cluster_uri_missing"
  | "cluster_uri_invalid"
  | "database_missing"
  | "database_invalid";

type ContractFailureCode =
  | "connect_failed"
  | "database_create_failed"
  | "schema_apply_failed"
  | "fixture_ingest_failed"
  | "query_execute_failed";

interface ContractConfiguration {
  readonly clusterUri: string;
  readonly database: string;
}

type ConfigurationResult =
  | { readonly configuration: ContractConfiguration; readonly error?: never }
  | { readonly configuration?: never; readonly error: ConfigurationErrorCode };

function isContractMode(args: readonly string[]): boolean {
  return args.length === 1 && contractModes.some((mode) => mode === args[0]);
}

function clusterUriError(clusterUri: string): ConfigurationErrorCode | undefined {
  let endpoint: URL;
  try {
    endpoint = new URL(clusterUri);
  } catch {
    return "cluster_uri_invalid";
  }
  return endpoint.protocol !== "http:" ||
    endpoint.hostname !== "kusto-emulator" ||
    endpoint.port !== "8080" ||
    endpoint.pathname !== "/" ||
    endpoint.search.length > 0 ||
    endpoint.hash.length > 0
    ? "cluster_uri_invalid"
    : undefined;
}

function databaseError(database: string): ConfigurationErrorCode | undefined {
  if (database.length === 0) {
    return "database_missing";
  }
  return database === emulatorDatabase ? undefined : "database_invalid";
}

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

/** Validates the explicit run flag and emulator connection configuration. */
export function getContractConfiguration(
  args: readonly string[],
  environment: Readonly<Record<string, string | undefined>>,
): ConfigurationResult {
  if (!isContractMode(args)) {
    return { error: "invalid_arguments" };
  }
  const clusterUri = environment.KUSTO_CLUSTER_URI;
  if (clusterUri === undefined || clusterUri.length === 0) {
    return { error: "cluster_uri_missing" };
  }
  const uriError = clusterUriError(clusterUri);
  if (uriError !== undefined) {
    return { error: uriError };
  }
  const database = environment.KUSTO_DATABASE;
  if (database === undefined || database.length === 0) {
    return { error: "database_missing" };
  }
  const dbError = databaseError(database);
  if (dbError !== undefined) {
    return { error: dbError };
  }
  return { configuration: { clusterUri, database } };
}

function createClient(clusterUri: string, database: string): Client {
  const endpoint = new URL(clusterUri);
  kustoTrustedEndpoints.addTrustedHosts([new MatchRule(endpoint.hostname, true)], false);
  return new Client(
    new KustoConnectionStringBuilder(
      `Data Source=${clusterUri};Initial Catalog=${database};AAD Federated Security=False`,
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
      throw new TypeError("kusto_fixture_count_mismatch");
    }
  }
}

async function ingestQueryFixtures(client: Client, database: string): Promise<void> {
  const fixtureText = await readFile(
    new URL("../../test/fixtures/kusto/safe-events.jsonl", import.meta.url),
    "utf8",
  );
  const fixtures = parseKustoLogFixtures(fixtureText);
  const timestamp = new Date().toISOString();
  for (const fixture of fixtures) {
    const recentFixture: KustoLogFixture = {
      ...fixture,
      Timestamp: timestamp,
      ObservedTimestamp: timestamp,
    };
    await client.executeMgmt(
      database,
      `.ingest inline into table HarnessLogs with (format='json', ingestionMappingReference='HarnessLogsMapping') <| ${JSON.stringify(recentFixture)}`,
    );
  }
}

function queryRows(response: Awaited<ReturnType<Client["executeQuery"]>>): unknown {
  const table = response.primaryResults[0];
  if (table === undefined) {
    throw new TypeError("kusto_query_result_missing");
  }
  return parseKustoQueryRows(table.toJSON().data);
}

async function executeQueries(client: Client, database: string): Promise<void> {
  const goldens = parseKustoQueryGoldens(
    await readFile(new URL("../../test/fixtures/kusto/query-results.json", import.meta.url), "utf8"),
  );
  assertKustoQueryGoldens(goldens);
  for (const name of kustoQueryNames) {
    const query = await readFile(new URL(`../../infra/kusto/queries/${name}.kql`, import.meta.url), "utf8");
    let response: Awaited<ReturnType<Client["executeQuery"]>>;
    try {
      response = await client.executeQuery(database, query);
    } catch {
      process.stderr.write(`kusto_query_${name}_execution_failed\n`);
      throw new TypeError("kusto_query_execution_failed");
    }
    const expected = goldens[name];
    if (expected === undefined) {
      throw new TypeError("kusto_query_golden_missing");
    }
    const actual = queryRows(response);
    try {
      deepStrictEqual(actual, expected);
    } catch {
      process.stderr.write(`kusto_query_${name}_golden_mismatch ${JSON.stringify(actual)}\n`);
      throw new TypeError("kusto_query_golden_mismatch");
    }
  }
}

async function dropDatabase(client: Client, database: string): Promise<void> {
  await client.executeMgmt(database, `.drop database ${database} ifexists`).catch(() => undefined);
}

async function runContract(
  clusterUri: string,
  baseDatabase: string,
  queryContract: boolean,
): Promise<void> {
  const database = createDatabaseName();
  let client: Client | undefined;
  let databaseCreated = false;
  let failureCode: ContractFailureCode = "connect_failed";
  try {
    client = createClient(clusterUri, baseDatabase);
    await client.executeMgmt(null, ".show cluster");
    failureCode = "database_create_failed";
    await createDatabase(client, database);
    databaseCreated = true;
    failureCode = "schema_apply_failed";
    await applySchema(client, database);
    if (queryContract) {
      failureCode = "fixture_ingest_failed";
      await ingestQueryFixtures(client, database);
      failureCode = "query_execute_failed";
      await executeQueries(client, database);
    } else {
      failureCode = "fixture_ingest_failed";
      await ingestFixtures(client, database, createFixtures(new Date().toISOString()));
    }
    process.stdout.write("kusto_emulator_contract_passed\n");
  } catch {
    process.stderr.write(`kusto_emulator_contract_${failureCode}\n`);
    process.exitCode = 1;
  } finally {
    if (client !== undefined && databaseCreated) {
      await dropDatabase(client, database);
    }
    client?.close();
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const result = getContractConfiguration(args, process.env);
  if (result.configuration === undefined) {
    process.stderr.write(`kusto_emulator_contract_${result.error}\n`);
    process.exitCode = 1;
    return;
  }
  await runContract(
    result.configuration.clusterUri,
    result.configuration.database,
    args[0] === "--queries",
  );
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main();
}
