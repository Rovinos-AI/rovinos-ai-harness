// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { getContractConfiguration } from "./emulator-contract-runner.ts";

describe("Kusto emulator contract configuration", () => {
  it("accepts the Compose service endpoint and its default database", () => {
    expect(
      getContractConfiguration(["--run"], {
        KUSTO_CLUSTER_URI: "http://kusto-emulator:8080",
        KUSTO_DATABASE: "NetDefaultDB",
      }),
    ).toEqual({
      configuration: {
        clusterUri: "http://kusto-emulator:8080",
        database: "NetDefaultDB",
      },
    });
    expect(
      getContractConfiguration(["--queries"], {
        KUSTO_CLUSTER_URI: "http://kusto-emulator:8080",
        KUSTO_DATABASE: "NetDefaultDB",
      }),
    ).toEqual({
      configuration: {
        clusterUri: "http://kusto-emulator:8080",
        database: "NetDefaultDB",
      },
    });
  });

  it("returns closed error codes for invalid endpoint or database configuration", () => {
    expect(
      getContractConfiguration(["--run"], {
        KUSTO_CLUSTER_URI: "http://localhost:8080",
        KUSTO_DATABASE: "NetDefaultDB",
      }),
    ).toEqual({ error: "cluster_uri_invalid" });
    expect(
      getContractConfiguration(["--run"], {
        KUSTO_CLUSTER_URI: "http://kusto-emulator:8080",
        KUSTO_DATABASE: "Harness",
      }),
    ).toEqual({ error: "database_invalid" });
  });
});
