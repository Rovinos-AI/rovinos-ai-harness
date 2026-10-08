// SPDX-License-Identifier: Apache-2.0
// Yarn 4 has no `licenses list` command, so report the installed package manifests directly.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseJson } from "@harness/schemas";
import { z } from "zod";
import parseSpdx from "spdx-expression-parse";

/** Schema for the repository's dependency-license policy. */
export const LicensePolicySchema = z
  .object({
    allow: z.array(z.string().min(1)),
    deny: z.array(z.string().min(1)),
    exceptions: z.array(
      z
        .object({
          package: z.string().min(1),
          version: z.string().min(1).optional(),
          reason: z.string().min(1),
          expires: z.iso.date(),
        })
        .strict(),
    ),
  })
  .strict();

/** Validated dependency-license policy. */
export type LicensePolicy = z.infer<typeof LicensePolicySchema>;

/** One installed dependency and its reported SPDX expression. */
export const LicensePackageSchema = z
  .object({
    name: z.string().min(1),
    version: z.string().min(1),
    license: z.string().min(1),
  })
  .strict();

/** A validated installed dependency. */
export type LicensePackage = z.infer<typeof LicensePackageSchema>;

/** One package or policy exception that fails the license check. */
export const LicenseViolationSchema = z
  .object({
    package: z.string(),
    version: z.string(),
    license: z.string(),
  })
  .strict();

/** A license evaluation result containing every package and policy violation. */
export type LicenseViolation = z.infer<typeof LicenseViolationSchema>;

const installedPackageSchema = z
  .object({
    name: z.string().min(1),
    version: z.string().min(1),
    license: z.unknown().optional(),
    licenses: z.array(z.object({ type: z.string().min(1) }).loose()).optional(),
  })
  .loose();

function matchesDeniedLicense(license: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) =>
    pattern.endsWith("*") ? license.startsWith(pattern.slice(0, -1)) : license === pattern,
  );
}

function expressionIsAllowed(
  expression: ReturnType<typeof parseSpdx>,
  policy: LicensePolicy,
): boolean {
  if ("conjunction" in expression) {
    return expression.conjunction === "and"
      ? expressionIsAllowed(expression.left, policy) &&
          expressionIsAllowed(expression.right, policy)
      : expressionIsAllowed(expression.left, policy) ||
          expressionIsAllowed(expression.right, policy);
  }
  const license =
    expression.license +
    (expression.plus === true ? "+" : "") +
    (expression.exception === undefined ? "" : ` WITH ${expression.exception}`);
  return policy.allow.includes(license) && !matchesDeniedLicense(expression.license, policy.deny);
}

function isExcepted(dependency: LicensePackage, policy: LicensePolicy, today: string): boolean {
  return policy.exceptions.some(
    (exception) =>
      exception.expires >= today &&
      exception.package === dependency.name &&
      (exception.version === undefined || exception.version === dependency.version),
  );
}

/**
 * Evaluates installed dependency licenses against the configured allowlist and exceptions.
 *
 * @param packages - Installed dependencies to evaluate.
 * @param policy - Validated license policy.
 * @param today - Current UTC date in `YYYY-MM-DD` form.
 * @returns Package and expired-exception violations.
 */
export function evaluateLicenses(
  packages: readonly LicensePackage[],
  policy: LicensePolicy,
  today: string,
): LicenseViolation[] {
  const violations: LicenseViolation[] = policy.exceptions
    .filter((exception) => exception.expires < today)
    .map((exception) => ({
      package: exception.package,
      version: exception.version ?? "*",
      license: `expired exception (${exception.expires})`,
    }));
  for (const dependency of packages) {
    if (isExcepted(dependency, policy, today)) {
      continue;
    }

    let allowed = false;
    try {
      allowed = expressionIsAllowed(parseSpdx(dependency.license), policy);
    } catch {
      allowed = false;
    }
    if (!allowed) {
      violations.push({
        package: dependency.name,
        version: dependency.version,
        license: dependency.license,
      });
    }
  }

  return violations;
}

function packageLicense(
  value: unknown,
  legacyLicenses: readonly { type: string }[] | undefined,
): string {
  if (value === undefined) {
    const legacyTypes = legacyLicenses?.map(({ type }) => type.trim()).filter(Boolean) ?? [];
    return legacyTypes.length > 0 ? legacyTypes.join(" OR ") : "UNLICENSED";
  }
  if (typeof value === "string" && value.trim().length > 0) {
    return value;
  }
  if (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    typeof value.type === "string" &&
    value.type.trim().length > 0
  ) {
    return value.type;
  }
  return "UNKNOWN";
}

function packageDirectories(nodeModules: string): string[] {
  const directories: string[] = [];
  for (const entry of readdirSync(nodeModules, { withFileTypes: true })) {
    if (entry.name === ".bin") {
      continue;
    }
    const entryPath = join(nodeModules, entry.name);
    if (entry.name.startsWith("@") && entry.isDirectory()) {
      for (const scopedEntry of readdirSync(entryPath, { withFileTypes: true })) {
        if (scopedEntry.isDirectory() || scopedEntry.isSymbolicLink()) {
          directories.push(join(entryPath, scopedEntry.name));
        }
      }
      continue;
    }
    if (entry.isDirectory() || entry.isSymbolicLink()) {
      directories.push(entryPath);
    }
  }
  return directories;
}

/** Reads installed dependency manifests beneath a project root. */
export async function readInstalledPackages(root: string): Promise<LicensePackage[]> {
  const pendingNodeModules = [join(root, "node_modules")];
  const packages = new Map<string, LicensePackage>();

  while (pendingNodeModules.length > 0) {
    const nodeModules = pendingNodeModules.pop();
    if (nodeModules === undefined || !existsSync(nodeModules)) {
      continue;
    }
    for (const packagePath of packageDirectories(nodeModules)) {
      await readInstalledPackage(packagePath, packages);
      if (existsSync(join(packagePath, "node_modules"))) {
        pendingNodeModules.push(join(packagePath, "node_modules"));
      }
    }
  }

  return [...packages.values()];
}

async function readInstalledPackage(
  packagePath: string,
  packages: Map<string, LicensePackage>,
): Promise<void> {
  const manifestPath = join(packagePath, "package.json");
  if (!existsSync(manifestPath)) {
    return;
  }
  const manifest = parseJson(installedPackageSchema, await readFile(manifestPath, "utf8"));
  const dependency = LicensePackageSchema.parse({
    name: manifest.name,
    version: manifest.version,
    license: packageLicense(manifest.license, manifest.licenses),
  });
  packages.set(`${dependency.name}@${dependency.version}`, dependency);
}

function sanitize(value: string): string {
  return Array.from(value, (character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint < 32 || (codePoint >= 127 && codePoint <= 159))
      ? "?"
      : character;
  }).join("");
}

function formatViolations(violations: readonly LicenseViolation[]): string {
  const rows = [
    ["PACKAGE", "VERSION", "LICENSE"],
    ...violations.map(({ package: name, version, license }) => [
      sanitize(name),
      sanitize(version),
      sanitize(license),
    ]),
  ];
  const widths = rows[0]?.map((_, column) =>
    Math.max(...rows.map((row) => row[column]?.length ?? 0)),
  );
  return rows
    .map((row) =>
      row
        .map((cell, column) => cell.padEnd(widths?.[column] ?? cell.length))
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
}

async function runCheck(): Promise<void> {
  const policy = parseJson(
    LicensePolicySchema,
    readFileSync(fileURLToPath(new URL("../config/license-policy.json", import.meta.url)), "utf8"),
  );
  const packages = await readInstalledPackages(process.cwd());
  const violations = evaluateLicenses(packages, policy, new Date().toISOString().slice(0, 10));
  if (violations.length > 0) {
    process.stderr.write(`${formatViolations(violations)}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await runCheck();
}
