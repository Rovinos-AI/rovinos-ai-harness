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
import { applySchemaFile } from "../scripts/kusto/apply-schema.ts";

const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function createDatabaseName(): string {
  const timestamp = BigInt(Date.now());
  const randomness = BigInt(`0x${randomBytes(10).toString("hex")}`);
  let value = (timestamp << 80n) | randomness;
  let ulid = "";
  for (let index = 0; index < 26; index += 1) {
    const character = alphabet[Number(value & 31n)];
    if (character === undefined) {
      throw new Error("invalid_ulid_character");
    }
    ulid = character + ulid;
    value >>= 5n;
  }
  return `h_${ulid}`;
}

function databaseCount(response: Awaited<ReturnType<Client["executeQuery"]>>): number {
  const value: unknown = response.primaryResults[0]?.rows().next().value?.getValueAt(0);
  if (typeof value !== "number") {
    throw new Error("kusto_count_result_missing");
  }
  return value;
}

async function runContract(): Promise<void> {
  let failureStep = "configuration";
  let client: Client | undefined;
  let database: string | undefined;
  let databaseCreated = false;

  try {
    if (
      process.argv.slice(2).length !== 1 ||
      process.argv[2] !== "--run" ||
      process.env.KUSTO_CLUSTER_URI === undefined
    ) {
      throw new Error("explicit_run_flag_required");
    }

    const clusterUri = process.env.KUSTO_CLUSTER_URI;
    if (clusterUri === undefined) {
      throw new Error("kusto_cluster_uri_missing");
    }
    const endpoint = new URL(clusterUri);
    if (endpoint.protocol !== "http:" || isIP(endpoint.hostname) !== 4) {
      throw new Error("kusto_emulator_endpoint_invalid");
    }

    database = createDatabaseName();
    kustoTrustedEndpoints.addTrustedHosts([new MatchRule(endpoint.hostname, true)], false);
    client = new Client(
      new KustoConnectionStringBuilder(
        `Data Source=${clusterUri};Initial Catalog=NetDefaultDB;AAD Federated Security=False`,
      ),
    );
    failureStep = "connect";
    await client.executeMgmt(null, ".show cluster");
    failureStep = "create_database";
    const databasePath = `/kustodata/dbs/${database}`;
    await client.executeMgmt(
      null,
      `.create database ${database} persist (@"${databasePath}/md", @"${databasePath}/data")`,
    );
    databaseCreated = true;

    let schemaCommandIndex = 0;
    const managementClient = {
      executeMgmt: async (targetDatabase: string | null, command: string): Promise<unknown> => {
        failureStep = `schema_command_${String(schemaCommandIndex)}`;
        schemaCommandIndex += 1;
        const result = await client?.executeMgmt(targetDatabase, command);
        if (result === undefined) {
          throw new Error("kusto_client_unavailable");
        }
        return result;
      },
    };
    failureStep = "apply_schema";
    await applySchemaFile(managementClient, database);
    failureStep = "reapply_schema";
    await applySchemaFile(managementClient, database);

    const timestamp = new Date().toISOString();
    const fixtures = [
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
    ] as const;

    for (const fixture of fixtures) {
      failureStep = `ingest_${fixture.table}`;
      await client.executeMgmt(
        database,
        `.ingest inline into table ${fixture.table} with (format='json', ingestionMappingReference='${fixture.mapping}') <| ${JSON.stringify(fixture.row)}`,
      );
      const response = await client.executeQuery(database, `${fixture.table} | count`);
      if (databaseCount(response) !== 1) {
        throw new Error("kusto_fixture_count_mismatch");
      }
    }
  } catch {
    process.stderr.write(`kusto_emulator_contract_failed_${failureStep}\n`);
    throw new Error("kusto_emulator_contract_failed");
  } finally {
    if (client !== undefined && databaseCreated && database !== undefined) {
      await client.executeMgmt(database, `.drop database ${database} ifexists`).catch(() => undefined);
    }
    client?.close();
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void runContract().then(
    () => {
      process.stdout.write("kusto_emulator_contract_passed\n");
    },
    () => {
      process.exitCode = 1;
    },
  );
}
