// SPDX-License-Identifier: Apache-2.0
import { RuleTester } from "@typescript-eslint/rule-tester";
import { ESLint } from "eslint";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { noRawTracerRule } from "./no-raw-tracer.ts";

const rootDirectory = resolve(import.meta.dirname, "../../../../");
const sourceFile = (relativePath: string): string => resolve("/", relativePath);

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.afterAll = afterAll;

const ruleTester = new RuleTester({
  languageOptions: { ecmaVersion: "latest", sourceType: "module" },
});

ruleTester.run("no-raw-tracer", noRawTracerRule, {
  valid: [
    {
      code: `
        import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
        const span = new BasicTracerProvider().getTracer("test").startSpan("test");
        span.setAttribute("harness.test", true);
      `,
      filename: sourceFile("packages/telemetry/src/registry.ts"),
    },
    {
      code: 'import { trace } from "@opentelemetry/api"; trace.getTracer("test");',
      filename: sourceFile("packages/telemetry/src/span.test.ts"),
    },
    {
      code: 'import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";',
      filename: sourceFile("packages/telemetry/src/testing.ts"),
    },
    {
      code: 'import type { SpanProcessor } from "@opentelemetry/sdk-trace-base";',
      filename: sourceFile("packages/core/src/span-types.ts"),
    },
    {
      code: "span.startSpan(); span.recordException(error);",
      filename: sourceFile("test/canary/telemetry.ts"),
    },
    {
      code: "span.startActiveSpan('test', () => {});",
      filename: sourceFile("test/fixtures/sample-mcp-server/server.ts"),
    },
    {
      code: "span.recordException(error);",
      filename: sourceFile("test/mcp-servers.int-client.test.mjs"),
    },
    {
      code: `
        import { trace } from "@opentelemetry/api";
        withSpan(definition, attributes, () => trace.getActiveSpan());
      `,
      filename: sourceFile("packages/core/src/spans.ts"),
    },
    {
      code: "span.startSpan(); span.startActiveSpan(); span.recordException(error); span.updateName(name);",
      filename: sourceFile("packages/core/src/span.test.ts"),
    },
    {
      code: 'import { trace } from "@opentelemetry/api"; trace.getActiveSpan();',
      filename: sourceFile("packages/core/src/spans.ts"),
    },
    {
      code: "span.startSpan(); span.setAttribute('test', true);",
      filename: sourceFile("packages/core/src/allowed.ts"),
      options: [{ allowedFiles: ["packages/core/src/**"] }],
    },
    {
      code: 'setActiveSpanAttribute("harness.error.code", "tool_failed");',
      filename: sourceFile("packages/core/src/recorder.ts"),
    },
    {
      code: `
        const element = document.createElement("div");
        element.setAttribute("role", "status");
      `,
      filename: sourceFile("packages/core/src/dom.ts"),
    },
  ],
  invalid: [
    {
      code: `
        const span = trace.getActiveSpan();
        tracer.startSpan("test");
        tracer.startActiveSpan("test", () => {});
        span.recordException(error);
        span.updateName("test");
        span.setAttribute("test", true);
        span.setAttributes({ test: true });
      `,
      filename: sourceFile("packages/core/src/spans.ts"),
      errors: [
        { messageId: "forbidden" },
        { messageId: "forbidden" },
        { messageId: "forbidden" },
        { messageId: "forbidden" },
        { messageId: "forbidden" },
        { messageId: "forbidden" },
      ],
    },
    {
      code: `
        trace.getSpan(ctx)?.setAttribute("test", true);
        const current = trace.getActiveSpan();
        current?.setAttributes({ test: true });
        const span = definition.start(attrs);
        span.setAttribute("test", true);
        function update(s: Span) {
          s.setAttribute("test", true);
        }
        let assigned: Span | undefined;
        assigned = trace.getSpan(ctx);
        assigned?.setAttributes({ test: true });
      `,
      filename: sourceFile("packages/core/src/spans.ts"),
      errors: [
        { messageId: "forbidden" },
        { messageId: "forbidden" },
        { messageId: "forbidden" },
        { messageId: "forbidden" },
        { messageId: "forbidden" },
      ],
    },
    {
      code: `
        const started = tracer.startSpan("test");
        started.setAttribute("test", true);
        const active = tracer.startActiveSpan("test", () => true);
        active?.setAttributes({ test: true });
      `,
      filename: sourceFile("packages/core/src/spans.ts"),
      errors: [
        { messageId: "forbidden" },
        { messageId: "forbidden" },
        { messageId: "forbidden" },
        { messageId: "forbidden" },
      ],
    },
    {
      code: 'import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";',
      filename: sourceFile("packages/core/src/spans.ts"),
      errors: [{ messageId: "forbidden" }],
    },
    {
      code: 'import { trace } from "@opentelemetry/api"; trace.getTracer("test");',
      filename: sourceFile("packages/core/src/spans.ts"),
      errors: [{ messageId: "forbidden" }],
    },
    {
      code: "const sdk = await import('@opentelemetry/sdk-trace-base');",
      filename: sourceFile("packages/core/src/spans.ts"),
      errors: [{ messageId: "forbidden" }],
    },
  ],
});

it("matches allowed files relative to ESLint's configured working directory", async () => {
  const originalCwd = process.cwd();
  process.chdir(tmpdir());
  try {
    const eslint = new ESLint({ cwd: rootDirectory });
    const [result] = await eslint.lintText('trace.getTracer("test");', {
      filePath: resolve(rootDirectory, "packages/telemetry/src/registry.ts"),
    });
    expect(result?.messages.map((message) => message.ruleId)).not.toContain(
      "harness/no-raw-tracer",
    );
  } finally {
    process.chdir(originalCwd);
  }
}, 15_000);

it("names the registered span APIs in its diagnostic", () => {
  expect(noRawTracerRule.meta.messages.forbidden).toContain(
    "defineSpan(...).start(...) or withSpan(...)",
  );
});
