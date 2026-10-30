// SPDX-License-Identifier: Apache-2.0
import { RuleTester } from "@typescript-eslint/rule-tester";
import { ESLint } from "eslint";
import { afterAll, describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHarnessPlugin } from "./index.js";

const rootDirectory = fileURLToPath(new URL("../../../", import.meta.url));
const eslint = new ESLint({ cwd: rootDirectory });
const typescriptFixture = resolve(rootDirectory, "packages/schemas/src/index.ts");
const javascriptFixture = resolve(rootDirectory, "packages/schemas/src/lint-fixture.js");
const harnessPlugin = createHarnessPlugin({
  schemas: [],
  telemetry: ["schemas"],
  store: ["schemas"],
});

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.afterAll = afterAll;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function firstRuleSetting(value: unknown): unknown {
  if (Array.isArray(value)) {
    const first: unknown = value[0];
    return first;
  }
  return value;
}

const ruleTester = new RuleTester({
  languageOptions: { ecmaVersion: "latest", sourceType: "module" },
});

ruleTester.run("import-direction", harnessPlugin.rules["import-direction"], {
  valid: [
    {
      code: "import schema from '@rovinos/schemas';",
      filename: resolve(rootDirectory, "packages/telemetry/src/layer.js"),
    },
  ],
  invalid: [
    {
      code: "import store from '@rovinos/store';",
      filename: resolve(rootDirectory, "packages/telemetry/src/layer.js"),
      errors: [{ messageId: "forbidden" }],
    },
  ],
});

ruleTester.run("no-relative-packages", harnessPlugin.rules["no-relative-packages"], {
  valid: [
    {
      code: "import './sibling.js';",
      filename: resolve(rootDirectory, "packages/telemetry/src/layer.js"),
    },
  ],
  invalid: [
    {
      code: "import store from '../../store/src/index.js';",
      filename: resolve(rootDirectory, "packages/telemetry/src/layer.js"),
      errors: [{ messageId: "forbidden" }],
    },
  ],
});

ruleTester.run("schema-inferred-types", harnessPlugin.rules["schema-inferred-types"], {
  valid: [
    {
      code: "export const ContractSchema = {}; export type Contract = z.infer<typeof ContractSchema>;",
    },
  ],
  invalid: [
    {
      code: "export const ContractSchema = {}; export interface Contract { readonly id: string; }",
      errors: [{ messageId: "forbidden" }],
    },
    {
      code: "const ContractSchema = {}; interface Contract { readonly id: string; } export { ContractSchema, Contract };",
      errors: [{ messageId: "forbidden" }],
    },
    {
      code: "const ContractSchema = {}; interface Contract { readonly id: string; } export { ContractSchema as PublicSchema, Contract as PublicContract };",
      errors: [{ messageId: "forbidden" }],
    },
  ],
});

ruleTester.run("metric-registry-only", harnessPlugin.rules["metric-registry-only"], {
  valid: [
    {
      code: 'meter.createCounter<NoMetricAttributes>("harness.test.count");',
      filename: resolve(rootDirectory, "packages/telemetry/src/metrics.ts"),
    },
    {
      code: 'meter.createCounter<TelemetryDropAttributes>("harness.telemetry.dropped");',
      filename: resolve(rootDirectory, "packages/telemetry/src/metrics.ts"),
    },
    {
      code: 'meter.createCounter<HostAppRejectedAttributes>("harness.host.app_rejected");',
      filename: resolve(rootDirectory, "packages/telemetry/src/metrics.ts"),
    },
    {
      code: 'meter.createCounter<PolicyDecisionAttributes>("harness.policy.decisions");',
      filename: resolve(rootDirectory, "packages/telemetry/src/metrics.ts"),
    },
    {
      code: 'meter.createCounter<ModelUsageAttributes>("harness.model.tokens");',
      filename: resolve(rootDirectory, "packages/telemetry/src/metrics.ts"),
    },
    {
      code: 'meter.createCounter<QuotaRejectionAttributes>("harness.quota.rejections");',
      filename: resolve(rootDirectory, "packages/telemetry/src/metrics.ts"),
    },
    {
      code: 'meter.createCounter<WorkerJobAttributes>("harness.worker.jobs");',
      filename: resolve(rootDirectory, "packages/telemetry/src/metrics.ts"),
    },
    {
      code: 'meter.createCounter<McpInputRequestAttributes>("harness.mcp.input_requests");',
      filename: resolve(rootDirectory, "packages/telemetry/src/metrics.ts"),
    },
    {
      code: 'meter.createCounter("harness.test.count");',
      filename: resolve(rootDirectory, "packages/telemetry/src/metrics.test.ts"),
    },
    {
      code: "values.add(value);",
      filename: resolve(rootDirectory, "packages/core/src/loop.ts"),
    },
  ],
  invalid: [
    {
      code: 'meter.createCounter("harness.test.count");',
      filename: resolve(rootDirectory, "packages/core/src/metrics.ts"),
      errors: [{ messageId: "forbidden" }],
    },
    {
      code: 'meter["createHistogram"]("harness.test.latency");',
      filename: resolve(rootDirectory, "packages/telemetry/src/new-metric.ts"),
      errors: [{ messageId: "forbidden" }],
    },
    {
      code: 'meter.createCounter("harness.test.count");',
      filename: resolve(rootDirectory, "packages/telemetry/src/metrics.ts"),
      errors: [{ messageId: "forbidden" }],
    },
    {
      code: 'meter.createCounter<{ readonly freeText: string }>("harness.test.count");',
      filename: resolve(rootDirectory, "packages/telemetry/src/metrics.ts"),
      errors: [{ messageId: "forbidden" }],
    },
    {
      code: "const counterFactory = meter.createCounter;",
      filename: resolve(rootDirectory, "packages/core/src/metrics.ts"),
      errors: [{ messageId: "forbidden" }],
    },
    {
      code: "const { createCounter } = meter;",
      filename: resolve(rootDirectory, "packages/core/src/metrics.ts"),
      errors: [{ messageId: "forbidden" }],
    },
    {
      code: 'createCounter("harness.test.count");',
      filename: resolve(rootDirectory, "packages/core/src/metrics.ts"),
      errors: [{ messageId: "forbidden" }],
    },
  ],
});

describe("ESLint configuration", () => {
  async function lint(code: string, filename = typescriptFixture) {
    const [result] = await eslint.lintText(code, { filePath: filename });
    return result?.messages ?? [];
  }

  it.each([
    ["explicit any", "const value: any = 1;", "@typescript-eslint/no-explicit-any"],
    [
      "non-null assertion",
      "const value: string | undefined = undefined;\nvalue!;",
      "@typescript-eslint/no-non-null-assertion",
    ],
    [
      "floating promise",
      "declare const pending: Promise<void>;\npending;",
      "@typescript-eslint/no-floating-promises",
    ],
    ["console usage", 'console.log("unsafe");', "no-console"],
    ["enum", "enum Mode { One }", "no-restricted-syntax"],
    ["default export", "export default function named() {}", "import-x/no-default-export"],
    [
      "deep nesting",
      "function nested(flag: boolean) { if (flag) { if (flag) { if (flag) { if (flag) { if (flag) { return; } } } } } }",
      "max-depth",
    ],
    ["unbraced control flow", "function run(flag: boolean) { if (flag) return; }", "curly"],
    ["super-linear regex", "const pattern = /(a+)+$/u;", "regexp/no-super-linear-backtracking"],
    ["untyped JSON parsing", 'JSON.parse("{}");', "no-restricted-properties"],
    [
      "unsafe browser HTML",
      'const target = document.createElement("div");\ntarget.innerHTML = "unsafe";',
      "no-restricted-properties",
      resolve(rootDirectory, "packages/approval-app/src/lint-fixture.js"),
    ],
    [
      "forbidden package direction",
      "import store from '@rovinos/store';",
      "harness/import-direction",
      resolve(rootDirectory, "packages/telemetry/src/lint-fixture.js"),
    ],
    [
      "relative package import",
      "import store from '../../store/src/index.js';",
      "harness/no-relative-packages",
      resolve(rootDirectory, "packages/telemetry/src/lint-fixture.js"),
    ],
    [
      "metric instrument outside the central registry",
      'meter.createCounter("harness.test.count");',
      "harness/metric-registry-only",
      typescriptFixture,
    ],
    [
      "focused test",
      'import { describe, it } from "vitest";\ndescribe.only("focused", () => { it("runs", () => {}); });',
      "vitest/no-focused-tests",
      resolve(rootDirectory, "packages/schemas/src/index.test.ts"),
    ],
  ])(
    "flags %s",
    async (_name, code, rule, filename?) => {
      const messages = await lint(code, filename);
      expect(messages.map((message) => message.ruleId)).toContain(rule);
    },
    15_000,
  );

  it.each([
    ["child_process", "packages/schemas/src/lint-fixture.js"],
    ["node:child_process", "packages/schemas/src/lint-fixture.js"],
    ["node:child_process", "packages/schemas/src/index.test.ts"],
    ["yaml", "packages/schemas/src/index.test.ts"],
    ["pino", "packages/schemas/src/index.ts"],
    ["fs", "packages/approval-app/src/lint-fixture.js"],
    ["node:fs", "packages/approval-app/src/lint-fixture.js"],
    ["node:fs", "packages/approval-app/src/lint-fixture.test.js"],
    ["fs/promises", "packages/approval-app/src/lint-fixture.js"],
    ["node:fs/promises", "packages/approval-app/src/lint-fixture.js"],
  ])("restricts %s imports outside approved boundaries", async (moduleName, filename) => {
    const messages = await lint(
      `import { readFile } from "${moduleName}";`,
      resolve(rootDirectory, filename),
    );
    expect(messages.map((message) => message.ruleId)).toContain("no-restricted-imports");
  });

  it("uses the shared TypeScript project for nested and co-located tests", async () => {
    const filenames = [
      resolve(rootDirectory, "packages/schemas/src/nested/steps/nested.test.ts"),
      resolve(rootDirectory, "packages/schemas/src/index.test.ts"),
    ];
    for (const filename of filenames) {
      const config: unknown = await eslint.calculateConfigForFile(filename);
      const parserOptions =
        isRecord(config) &&
        isRecord(config.languageOptions) &&
        isRecord(config.languageOptions.parserOptions)
          ? config.languageOptions.parserOptions
          : {};
      expect(parserOptions.project).toBeUndefined();
      expect(parserOptions.projectService).toEqual({
        allowDefaultProject: ["packages/*/tsup.config.ts", "vitest.config.ts"],
        defaultProject: "packages/schemas/tsconfig.test.json",
      });
    }
  });

  it("type-checks the JavaScript package boundary implementation", async () => {
    const config: unknown = await eslint.calculateConfigForFile(
      resolve(rootDirectory, "tools/eslint-plugin-harness/src/index.js"),
    );
    const rules = isRecord(config) && isRecord(config.rules) ? config.rules : {};
    expect(firstRuleSetting(rules["@typescript-eslint/strict-boolean-expressions"])).toBe(2);
    expect(firstRuleSetting(rules["@typescript-eslint/consistent-type-assertions"])).toBe(2);
  });

  it.each([
    ["arrow function", "export const answer = () => 42;"],
    ["function expression", "export const answer = function () { return 42; };"],
    ["class expression", "export const Answer = class {};"],
  ])("requires TSDoc for exported %s", async (_name, code) => {
    const messages = await lint(code);
    expect(messages.map((message) => message.ruleId)).toContain("jsdoc/require-jsdoc");
  });

  it("accepts clean code", async () => {
    expect(await lint("export const answer = 42;")).toEqual([]);
  });

  it("enables the raw tracer rule as an error", async () => {
    const config: unknown = await eslint.calculateConfigForFile(
      resolve(rootDirectory, "packages/core/src/recorder.ts"),
    );
    const rules = isRecord(config) && isRecord(config.rules) ? config.rules : {};
    expect(firstRuleSetting(rules["harness/no-raw-tracer"])).toBe(2);
  });

  it("applies generated and build ignores globally", async () => {
    for (const filename of [
      "packages/schemas/dist/index.js",
      "packages/schemas/src/generated.generated.ts",
      "docs/api/index.js",
    ]) {
      expect(await eslint.isPathIgnored(resolve(rootDirectory, filename))).toBe(true);
    }
  });

  it("keeps curly enforcement enabled after Prettier config", async () => {
    const config: unknown = await eslint.calculateConfigForFile(javascriptFixture);
    const rules = isRecord(config) && isRecord(config.rules) ? config.rules : {};
    expect(rules.curly).toEqual([2, "all"]);
  });

  it("resolves no warning-level rules", async () => {
    for (const filename of [
      typescriptFixture,
      javascriptFixture,
      resolve(rootDirectory, "packages/schemas/src/index.test.ts"),
    ]) {
      const config: unknown = await eslint.calculateConfigForFile(filename);
      const rules = isRecord(config) && isRecord(config.rules) ? Object.values(config.rules) : [];
      const severities = rules.map(firstRuleSetting);
      expect(severities).not.toContain("warn");
      expect(severities).not.toContain(1);
    }
  });

  it("requires a reason for disable comments", async () => {
    const messages = await lint(
      "// eslint-disable-next-line no-alert\nalert('unsafe');",
      javascriptFixture,
    );
    expect(messages.map((message) => message.ruleId)).toContain(
      "eslint-comments/require-description",
    );
  });

  it("rejects inline disables for restricted rules", async () => {
    const messages = await lint(
      "// eslint-disable-next-line no-console -- temporary exception\nconsole.log('unsafe');",
      javascriptFixture,
    );
    expect(messages.map((message) => message.ruleId)).toContain(
      "eslint-comments/no-restricted-disable",
    );
  });

  it("reports unused disable directives", async () => {
    const messages = await lint(
      "/* eslint-disable no-debugger -- no debugger is present */\nconst value = 1;",
      javascriptFixture,
    );
    expect(messages.some((message) => message.message.toLowerCase().includes("unused"))).toBe(true);
  });
});
