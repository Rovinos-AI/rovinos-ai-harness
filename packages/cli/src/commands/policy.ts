// SPDX-License-Identifier: Apache-2.0
import { readFile } from "node:fs/promises";
import {
  Id,
  HarnessError,
  parseJson,
  parseYaml,
  PolicyLintResultSchema,
  PolicyTestCallSchema,
  PolicyTestExpectationSchema,
  PolicyTestResultSchema,
} from "@rovinos/schemas";
import type { PolicyTestCall, PolicyTestExpectation, PolicyTestResult } from "@rovinos/schemas";
import type { CompiledPolicy } from "@rovinos/policy";
import type { Detector } from "@rovinos/pii";
import { z } from "zod";
import type { CliContext, CommandModule } from "../command.js";

type PolicyCommandErrorCode =
  | "policy_test_mismatch"
  | "policy_lint_failed"
  | "policy_test_ids_duplicate"
  | "policy_expectations_ids_duplicate";

const POLICY_TEST_RUN_ID = Id.parse("00000000000000000000000000");

const TestOptionsSchema = z
  .object({
    policy: z.string(),
    calls: z.string(),
    expect: z.string().optional(),
    explain: z.boolean().default(false),
  })
  .strict();

const LintOptionsSchema = z.object({ policy: z.string() }).strict();

class PolicyCommandError extends HarnessError {
  override readonly code: PolicyCommandErrorCode;

  constructor(code: PolicyCommandErrorCode) {
    super(code);
    this.code = code;
  }
}

async function readPolicy(path: string) {
  const { PolicyDocumentSchema } = await import("@rovinos/policy");
  return parseYaml(PolicyDocumentSchema, await readFile(path, "utf8"));
}

async function readJsonLines<Schema extends z.ZodType>(
  path: string,
  schema: Schema,
): Promise<z.infer<Schema>[]> {
  const text = await readFile(path, "utf8");
  return text
    .split(/\r?\n/u)
    .filter((line) => line.trim().length > 0)
    .map((line) => parseJson(schema, line));
}

function ensureUniqueIds(
  items: readonly { readonly id: string }[],
  code: "policy_test_ids_duplicate" | "policy_expectations_ids_duplicate",
): void {
  const ids = new Set<string>();
  for (const item of items) {
    if (ids.has(item.id)) {
      throw new PolicyCommandError(code);
    }
    ids.add(item.id);
  }
}

function compareExpectation(
  actual: PolicyTestResult["results"][number],
  expected: PolicyTestExpectation | undefined,
  checkExpectations: boolean,
): PolicyTestResult["mismatches"][number] | undefined {
  if (!checkExpectations) {
    return undefined;
  }
  if (expected === undefined) {
    return { id: actual.id, code: "expectation_missing", actual };
  }
  if (actual.decision !== expected.decision) {
    return { id: actual.id, code: "decision_mismatch", expected, actual };
  }
  if (expected.ruleId !== undefined && actual.ruleId !== expected.ruleId) {
    return { id: actual.id, code: "rule_id_mismatch", expected, actual };
  }
  return undefined;
}

interface PolicyTestExecution {
  readonly compiled: CompiledPolicy;
  readonly calls: readonly PolicyTestCall[];
  readonly expectations: readonly PolicyTestExpectation[];
  readonly checkExpectations: boolean;
  readonly explain: boolean;
  readonly cliContext: CliContext;
}

async function testPolicyResult({
  compiled,
  calls,
  expectations,
  checkExpectations,
  explain,
  cliContext,
}: PolicyTestExecution): Promise<PolicyTestResult> {
  const expectedById = new Map(expectations.map((expectation) => [expectation.id, expectation]));
  const results: PolicyTestResult["results"] = [];
  const mismatches: PolicyTestResult["mismatches"] = [];
  const config = await cliContext.loadConfig();
  const pii = await import("@rovinos/pii");
  const { InMemoryVault } = await import("@rovinos/vault");
  const builtInAndCustomDetectors: readonly Detector[] = [
    pii.creditCardDetector,
    pii.emailDetector,
    pii.ibanDetector,
    pii.ipDetector,
    pii.phoneDetector,
    pii.secretsDetector,
    pii.urlCredentialsDetector,
    ...(config.pii.custom ?? []).map((detector) => pii.createCustomDetector(detector)),
  ];
  const vault = new InMemoryVault();
  const tokenizer = new pii.Tokenizer({
    detectors: {
      detect: (text) =>
        pii.resolveOverlaps(builtInAndCustomDetectors.flatMap((detector) => detector.detect(text))),
    },
    policy: config.pii,
    vault,
  });

  for (const fixture of calls) {
    const context = {
      subagent: fixture.context?.subagent ?? false,
      ...(fixture.context?.server === undefined ? {} : { server: fixture.context.server }),
      ...(fixture.context?.app === undefined ? {} : { app: fixture.context.app }),
    };
    const tokenized = await tokenizer.tokenizeJson(POLICY_TEST_RUN_ID, fixture.args, {
      boundary: "tool_input",
      destination: { tool: fixture.toolId },
    });
    const explanation = compiled.evaluate({
      toolId: fixture.toolId,
      args: tokenized.value,
      context,
    });
    const result = {
      id: fixture.id,
      decision: explanation.decision,
      ruleId: explanation.ruleId,
      reason: explanation.reason,
      ...(explain ? { matched: explanation.matched } : {}),
    };
    results.push(result);

    const expected = expectedById.get(fixture.id);
    if (expected !== undefined) {
      expectedById.delete(fixture.id);
    }
    const mismatch = compareExpectation(result, expected, checkExpectations);
    if (mismatch !== undefined) {
      mismatches.push(mismatch);
    }
  }

  if (checkExpectations) {
    for (const expected of expectedById.values()) {
      mismatches.push({ id: expected.id, code: "call_missing", expected });
    }
  }
  return PolicyTestResultSchema.parse({ results, mismatches });
}

function testSummary(result: PolicyTestResult): string {
  const lines = result.results.map(
    ({ id, decision, ruleId, reason, matched }) =>
      `${id}\t${decision}\t${ruleId}\t${reason}${
        matched === undefined
          ? ""
          : `\t${matched.map(({ ruleId: matchedId }) => matchedId).join(",")}`
      }\n`,
  );
  for (const mismatch of result.mismatches) {
    const expected = mismatch.expected;
    const actual = mismatch.actual;
    lines.push(
      `FAIL ${mismatch.id}: expected ${expected?.decision ?? "call"}${
        expected?.ruleId === undefined ? "" : ` (${expected.ruleId})`
      }, got ${actual?.decision ?? "missing"}${
        actual?.ruleId === undefined ? "" : ` (${actual.ruleId})`
      }\n`,
    );
  }
  if (lines.length === 0) {
    return "No policy calls.\n";
  }
  return lines.join("");
}

async function runTest(rawOptions: unknown, context: CliContext, jsonMode: boolean): Promise<void> {
  const options = TestOptionsSchema.parse(rawOptions);
  const document = await readPolicy(options.policy);
  const calls = await readJsonLines(options.calls, PolicyTestCallSchema);
  const expectations =
    options.expect === undefined
      ? []
      : await readJsonLines(options.expect, PolicyTestExpectationSchema);
  ensureUniqueIds(calls, "policy_test_ids_duplicate");
  ensureUniqueIds(expectations, "policy_expectations_ids_duplicate");

  const { compilePolicy } = await import("@rovinos/policy");
  const result = await testPolicyResult({
    compiled: compilePolicy(document),
    calls,
    expectations,
    checkExpectations: options.expect !== undefined,
    explain: options.explain,
    cliContext: context,
  });
  context.out.json(PolicyTestResultSchema, result);
  if (!jsonMode) {
    context.out.print(testSummary(result));
  }
  if (result.mismatches.length > 0) {
    throw new PolicyCommandError("policy_test_mismatch");
  }
}

async function runLint(rawOptions: unknown, context: CliContext, jsonMode: boolean): Promise<void> {
  const options = LintOptionsSchema.parse(rawOptions);
  const { lintPolicy } = await import("@rovinos/policy");
  const input = parseYaml(z.unknown(), await readFile(options.policy, "utf8"));
  const result = PolicyLintResultSchema.parse(lintPolicy(input));
  context.out.json(PolicyLintResultSchema, result);
  if (!jsonMode) {
    const report =
      result.diagnostics.length === 0
        ? "Policy lint passed.\n"
        : `${result.diagnostics
            .map(
              ({ severity, code, ruleId }) =>
                `${severity}: ${code}${ruleId === undefined ? "" : ` ${ruleId}`}`,
            )
            .join("\n")}\n`;
    context.out.print(report);
  }
  if (result.diagnostics.some(({ severity }) => severity === "error")) {
    throw new PolicyCommandError("policy_lint_failed");
  }
}

/** Registers offline policy test and lint commands. */
export const policyCommand: CommandModule = {
  name: "policy",
  /** Registers the `policy` command. */
  register(program, context) {
    const policy = program.command("policy").description("Test and lint policy files");
    policy
      .command("test")
      .description("Tokenize and evaluate call fixtures against a policy")
      .requiredOption("--policy <file>", "policy YAML or JSON file")
      .requiredOption("--calls <jsonl>", "JSONL tool call fixture file")
      .option("--expect <jsonl>", "JSONL expectation file")
      .option("--explain", "include all matching rules")
      .action(async (rawOptions: unknown) => {
        await runTest(rawOptions, context, program.opts<{ json?: boolean }>().json === true);
      });
    policy
      .command("lint")
      .description("Check a policy for rule defects")
      .requiredOption("--policy <file>", "policy YAML or JSON file")
      .action(async (rawOptions: unknown) => {
        await runLint(rawOptions, context, program.opts<{ json?: boolean }>().json === true);
      });
  },
};
