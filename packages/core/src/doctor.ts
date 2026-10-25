// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  Code,
  HarnessError,
  SecretRefSchema,
  type Code as HarnessCode,
  type DoctorCheckStatus,
  type DoctorCheckResult,
  type SecretRef,
} from "@rovinos/schemas";
import { AkvSecretResolverError } from "@rovinos/vault";

/** Inputs available to registered environment checks. */
export interface DoctorContext {
  /** Validated configuration, or `undefined` when loading failed. */
  readonly config: unknown;
  /** Closed error code from config loading, when validation failed. */
  readonly configErrorCode?: HarnessCode;
  /** Secret references extracted from schema-owned config fields. */
  readonly secretRefs: readonly SecretRef[];
  /** Environment used to load configuration and resolve references. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Data directory selected for harness runtime state. */
  readonly dataDir: string;
  /** Resolves a reference without returning or retaining its secret value. */
  readonly resolveSecret: (
    ref: SecretRef,
    signal?: AbortSignal,
  ) => Promise<HarnessCode | undefined>;
  /** Node version override for deterministic checks. */
  readonly nodeVersion?: string;
  /** Per-check cancellation signal, set by the doctor runner. */
  readonly signal?: AbortSignal;
}

/** One registered environment diagnostic. */
export interface DoctorCheck {
  /** Stable machine-readable identifier. */
  readonly id: Code;
  /** Short human-readable check title. */
  readonly title: string;
  /** Executes the check and returns only safe status metadata. */
  run(ctx: DoctorContext): Promise<DoctorCheckStatus>;
}

/** Default timeout applied independently to each check. */
export const DEFAULT_DOCTOR_TIMEOUT_MS = 5_000;

/** Internal registry of built-in and package-registered checks. */
const registeredDoctorChecks: DoctorCheck[] = [];

class DuplicateDoctorCheckError extends HarnessError {
  override readonly code = "doctor_check_duplicate";

  constructor() {
    super("A doctor check with this id is already registered.");
  }
}

/** Registers a diagnostic check for subsequent `runDoctor` invocations. */
export function registerDoctorCheck(check: DoctorCheck): void {
  if (registeredDoctorChecks.some(({ id }) => id === check.id)) {
    throw new DuplicateDoctorCheckError();
  }
  registeredDoctorChecks.push(check);
}

/** Returns a frozen snapshot of all currently registered checks. */
export function doctorChecks(): readonly DoctorCheck[] {
  return Object.freeze([...registeredDoctorChecks]);
}

function result(status: DoctorCheckStatus["status"], code: Code, detail?: Code) {
  return { status, code, ...(detail === undefined ? {} : { detail }) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function safeReferenceName(ref: SecretRef): Code {
  const [scheme, name = "unknown"] = ref.split(":");
  const basename =
    name
      .split(/[/:\\]/u)
      .filter(Boolean)
      .at(-1) ?? "unknown";
  const safeName = basename.toLowerCase().replaceAll(/[^a-z0-9_.-]/gu, "_");
  return Code.parse(`${scheme ?? "secret"}_${safeName}`.slice(0, 64));
}

function knownSecretErrorCode(error: unknown): Code {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = error.code;
    if (
      code === "secret_not_found" ||
      code === "secret_ref_invalid" ||
      code === "secret_resolver_unavailable" ||
      code === "secret_file_permissions"
    ) {
      return code;
    }
  }
  return "secret_unavailable";
}

function isUnavailableAkvResolver(error: unknown, errorCode: Code, ref: SecretRef): boolean {
  return (
    errorCode === "secret_resolver_unavailable" &&
    ref.startsWith("akv:") &&
    !(error instanceof AkvSecretResolverError)
  );
}

const initialChecks: DoctorCheck[] = [
  {
    id: "node_version",
    title: "Node.js version",
    run: (ctx) => {
      const major = Number(/^\d+/u.exec(ctx.nodeVersion ?? process.versions.node)?.[0]);
      return Promise.resolve(
        major >= 22 ? result("ok", "node_version") : result("fail", "node_version_unsupported"),
      );
    },
  },
  {
    id: "config_valid",
    title: "Configuration",
    run: (ctx) =>
      Promise.resolve(
        ctx.config === undefined
          ? result("fail", "config_invalid", ctx.configErrorCode)
          : result("ok", "config_valid"),
      ),
  },
  {
    id: "policy_configured",
    title: "Policy configuration",
    run: (ctx) => {
      if (!isRecord(ctx.config)) {
        return Promise.resolve(result("ok", "policy_configured"));
      }
      const policy = ctx.config.policy;
      const hasPolicyFile = isRecord(policy) && typeof policy.file === "string";
      return Promise.resolve(
        hasPolicyFile ? result("ok", "policy_configured") : result("warn", "policy_default_deny"),
      );
    },
  },
  {
    id: "secret_refs_resolvable",
    title: "Secret references",
    run: async (ctx) => {
      let firstFailure: DoctorCheckStatus | undefined;
      let firstWarning: DoctorCheckStatus | undefined;
      for (const rawRef of ctx.secretRefs) {
        if (isAborted(ctx.signal)) {
          return result("fail", "check_timeout");
        }
        const parsed = SecretRefSchema.safeParse(rawRef);
        if (!parsed.success) {
          continue;
        }
        try {
          const warning = await ctx.resolveSecret(parsed.data, ctx.signal);
          if (isAborted(ctx.signal)) {
            return result("fail", "check_timeout");
          }
          if (warning === "secret_file_permissions") {
            firstWarning ??= result("warn", warning, safeReferenceName(parsed.data));
          }
        } catch (error) {
          if (isAborted(ctx.signal)) {
            return result("fail", "check_timeout");
          }
          const errorCode = knownSecretErrorCode(error);
          if (isUnavailableAkvResolver(error, errorCode, parsed.data)) {
            firstWarning ??= result("warn", errorCode, safeReferenceName(parsed.data));
          } else {
            firstFailure ??= result("fail", errorCode, safeReferenceName(parsed.data));
          }
        }
      }
      return firstFailure ?? firstWarning ?? result("ok", "secret_refs_resolvable");
    },
  },
  {
    id: "data_dir_writable",
    title: "Data directory writable",
    run: async (ctx) => {
      let temporaryDirectory: string | undefined;
      try {
        await mkdir(ctx.dataDir, { recursive: true });
        if (isAborted(ctx.signal)) {
          return result("fail", "check_timeout");
        }
        temporaryDirectory = await mkdtemp(join(ctx.dataDir, ".harness-doctor-"));
        if (isAborted(ctx.signal)) {
          return result("fail", "check_timeout");
        }
        const temporaryFile = join(temporaryDirectory, "write-check");
        if (ctx.signal === undefined) {
          await writeFile(temporaryFile, "");
        } else {
          await writeFile(temporaryFile, "", { signal: ctx.signal });
        }
        if (isAborted(ctx.signal)) {
          return result("fail", "check_timeout");
        }
        await rm(temporaryDirectory, { recursive: true });
        temporaryDirectory = undefined;
        return result("ok", "data_dir_writable");
      } catch {
        return result("fail", "data_dir_write_failed");
      } finally {
        if (temporaryDirectory !== undefined) {
          await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined);
        }
      }
    },
  },
];

for (const check of initialChecks) {
  registerDoctorCheck(check);
}

async function runCheck(
  check: DoctorCheck,
  ctx: DoctorContext,
  timeoutMs: number,
): Promise<DoctorCheckResult> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<DoctorCheckResult>((resolve) => {
    timeout = setTimeout(() => {
      controller.abort();
      resolve({ id: check.id, ...result("fail", "check_timeout") });
    }, timeoutMs);
  });
  try {
    const checkResult = check.run({ ...ctx, signal: controller.signal }).then(
      (value) => ({ id: check.id, ...value }),
      () => ({ id: check.id, ...result("fail", "check_failed") }),
    );
    return await Promise.race([checkResult, timedOut]);
  } catch {
    return { id: check.id, ...result("fail", "check_failed") };
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

/**
 * Runs registered diagnostics in order, applying an independent timeout to each check.
 *
 * @param ctx - Validated environment and injected boundary operations.
 * @param checks - Ordered checks; defaults to the extensible global registry.
 * @param timeoutMs - Per-check timeout in milliseconds.
 * @returns Safe check results without exception messages or resolved secret values.
 */
export async function runDoctor(
  ctx: DoctorContext,
  checks: readonly DoctorCheck[] = doctorChecks(),
  timeoutMs = DEFAULT_DOCTOR_TIMEOUT_MS,
): Promise<DoctorCheckResult[]> {
  const results: DoctorCheckResult[] = [];
  for (const check of checks) {
    results.push(await runCheck(check, ctx, timeoutMs));
  }
  return results;
}
