// SPDX-License-Identifier: Apache-2.0
import { foldRunState } from "@rovinos/core";
import type { Runtime } from "@rovinos/core";
import { ApprovalEditError, applyApprovalEdits } from "@rovinos/policy";
import {
  ApprovalPayloadSchema,
  HarnessError,
  JsonValue as JsonValueSchema,
  parseTokenType,
} from "@rovinos/schemas";
import type { ApprovalPayload, Id, JsonValue, RunStatus } from "@rovinos/schemas";
import type { ApprovalCounts } from "./trial.js";
import { HumanScriptSchema } from "./schema.js";
import type { HumanScript } from "./schema.js";

type SimulatedHumanRuntime = Pick<Runtime, "resolveApproval"> & {
  readonly store: Pick<Runtime["store"], "read">;
};

interface MutableApprovalCounts {
  approved: number;
  denied: number;
  edited: number;
}

/** Result of applying a human script to a run until it is no longer awaiting approval. */
export interface SimulatedHumanRunResult {
  readonly status: RunStatus;
  readonly maxResumesExceeded: boolean;
}

/** Coded failure raised when an approval payload cannot be matched safely. */
export class SimulatedHumanError extends HarnessError {
  readonly code = "human_approval_payload_invalid";

  constructor() {
    super("A simulated human could not validate the pending approval payload.");
    this.name = "SimulatedHumanError";
  }
}

function equalJson(left: JsonValue, right: JsonValue): boolean {
  if (left === right) {
    return true;
  }
  if (typeof left !== "object" || left === null || typeof right !== "object" || right === null) {
    return false;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => {
        const other = right[index];
        return other !== undefined && equalJson(value, other);
      })
    );
  }
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key) => {
      const value = left[key];
      const other = right[key];
      return value !== undefined && other !== undefined && equalJson(value, other);
    })
  );
}

function valueAtPointer(value: JsonValue, pointer: string): JsonValue | undefined {
  if (pointer === "") {
    return value;
  }
  let current: JsonValue | undefined = value;
  for (const rawPart of pointer.slice(1).split("/")) {
    const part = rawPart.replaceAll("~1", "/").replaceAll("~0", "~");
    if (Array.isArray(current)) {
      if (!/^(?:0|[1-9]\d*)$/u.test(part)) {
        return undefined;
      }
      current = current[Number(part)];
    } else if (typeof current === "object" && current !== null) {
      current = current[part];
    } else {
      return undefined;
    }
    if (current === undefined) {
      return undefined;
    }
  }
  return current;
}

function equalsTokenAware(actual: JsonValue | undefined, expected: JsonValue): boolean {
  if (typeof actual === "string") {
    const tokenType = parseTokenType(actual);
    if (tokenType !== undefined) {
      if (typeof expected !== "string") {
        return false;
      }
      const expectedType = parseTokenType(expected) ?? expected;
      return tokenType.toLowerCase() === expectedType.toLowerCase();
    }
  }
  return actual !== undefined && equalJson(actual, expected);
}

function matchesRule(rule: HumanScript["rules"][number], payload: ApprovalPayload): boolean {
  const { match } = rule;
  if (match.toolId !== undefined && match.toolId !== payload.toolId) {
    return false;
  }
  if (match.ruleId !== undefined && match.ruleId !== payload.ruleId) {
    return false;
  }
  if (match.pointerEquals !== undefined) {
    const actual = valueAtPointer(payload.args, match.pointerEquals.pointer);
    if (!equalsTokenAware(actual, match.pointerEquals.value)) {
      return false;
    }
  }
  return true;
}

/** Drives approval decisions through the runtime's normal resolution and resume APIs. */
export class SimulatedHuman {
  private readonly script: HumanScript;
  private readonly approvalCounts: MutableApprovalCounts = { approved: 0, denied: 0, edited: 0 };

  /**
   * @param script - Validated or untrusted human script; parsed at construction.
   * @param runtime - Runtime methods used for durable approval resolution.
   */
  constructor(
    script: HumanScript,
    private readonly runtime: SimulatedHumanRuntime,
  ) {
    this.script = HumanScriptSchema.parse(script);
  }

  /** Metadata-only counts of decisions successfully recorded by this simulated human. */
  get counts(): ApprovalCounts {
    return { ...this.approvalCounts };
  }

  /** Whether the script explicitly enables unsafe default auto-approval. */
  get unsafeAutoApprove(): boolean {
    return this.script.unsafeAutoApprove === true;
  }

  /** Returns whether the run currently contains one or more unresolved approvals. */
  async hasPendingApprovals(runId: Id): Promise<boolean> {
    const events = [];
    for await (const event of this.runtime.store.read(runId)) {
      events.push(event);
    }
    return foldRunState(events).pendingApprovals.size > 0;
  }

  /**
   * Resolves all approvals pending at the start of this step.
   *
   * @param runId - Run whose durable approval requests are being processed.
   * @returns Number of approvals resolved.
   */
  async step(runId: Id): Promise<number> {
    const events = [];
    for await (const event of this.runtime.store.read(runId)) {
      events.push(event);
    }
    const state = foldRunState(events);
    const pending = [...state.pendingApprovals.values()];
    for (const approval of pending) {
      const parsed = ApprovalPayloadSchema.safeParse(approval.payload);
      if (!parsed.success) {
        throw new SimulatedHumanError();
      }
      const payload = parsed.data;
      const rule = this.script.rules.find((candidate) => matchesRule(candidate, payload));
      const decision = rule?.decision ?? this.script.default;
      let edits: JsonValue | undefined;
      if (decision === "edit" && rule?.edits !== undefined) {
        const applied = applyApprovalEdits(payload.args, rule.edits);
        if (!applied.success) {
          throw new ApprovalEditError("edit_invalid");
        }
        edits = JsonValueSchema.parse(applied.args);
      }
      await this.runtime.resolveApproval(runId, approval.approvalId, decision, {
        ...(edits === undefined ? {} : { edits }),
        metadata: { decidedBy: "human", approverId: "eval.simulated" },
      });
      if (decision === "approve") {
        this.approvalCounts.approved += 1;
      } else if (decision === "deny") {
        this.approvalCounts.denied += 1;
      } else {
        this.approvalCounts.edited += 1;
      }
    }
    return pending.length;
  }

  /**
   * Resolves pending approvals and resumes the run until approval is no longer pending.
   *
   * @param runId - Run to drive.
   * @param initialStatus - Status returned by the initial run or most recent resume.
   * @param resume - Executor-specific callback that resumes the run through core.
   * @returns Final observed status and whether the script's resume limit was exhausted.
   */
  async runUntilSettled(
    runId: Id,
    initialStatus: RunStatus,
    resume: () => Promise<RunStatus>,
  ): Promise<SimulatedHumanRunResult> {
    let status = initialStatus;
    let resumes = 0;
    while (status === "suspended" && (await this.hasPendingApprovals(runId))) {
      if (resumes >= this.script.maxResumes) {
        return { status, maxResumesExceeded: true };
      }
      await this.step(runId);
      status = await resume();
      resumes += 1;
    }
    return { status, maxResumesExceeded: false };
  }
}
