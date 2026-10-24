// SPDX-License-Identifier: Apache-2.0
// File permission warnings use an injected callback because this package has no logger yet.
import { readFile as readFileFromDisk, stat as statFromDisk } from "node:fs/promises";
import { inspect } from "node:util";
import { HarnessError, SecretRefSchema, type SecretRef } from "@rovinos/schemas";

/** Stable error codes raised while resolving a secret reference. */
export type SecretResolutionErrorCode =
  | "secret_access_denied"
  | "secret_not_found"
  | "secret_ref_invalid"
  | "secret_resolver_unavailable"
  | "secret_resolution_cancelled";

/** Safe error raised when a secret reference cannot be resolved. */
export class SecretResolutionError extends HarnessError {
  override readonly code: SecretResolutionErrorCode;

  /**
   * Creates an error containing only its stable code.
   *
   * @param code - Stable reason for the resolution failure.
   */
  constructor(code: SecretResolutionErrorCode) {
    super(code);
    this.code = code;
  }
}

/** A secret value that redacts automatically when converted to text or inspected. */
export class Secret {
  readonly #value: string;

  /**
   * Wraps a secret value for use at an integration boundary.
   *
   * @param value - The secret value, kept in a private field.
   */
  constructor(value: string) {
    this.#value = value;
  }

  /** Reveals the value to code that explicitly needs to use the secret. */
  reveal(): string {
    return this.#value;
  }

  /** Returns a redacted representation for string conversion. */
  toString(): string {
    return "[REDACTED]";
  }

  /** Returns a redacted representation for JSON serialization. */
  toJSON(): string {
    return "[REDACTED]";
  }

  /** Returns a redacted representation for Node.js inspection. */
  [inspect.custom](): string {
    return "[REDACTED]";
  }
}

/** Resolves a validated reference into an opaque secret value. */
export interface SecretResolver {
  /** Resolves a secret without exposing its value in errors. */
  /**
   * @param ref - Validated external secret reference.
   * @param signal - Optional cancellation signal for the resolution operation.
   */
  resolve(ref: SecretRef, signal?: AbortSignal): Promise<Secret>;
}

/** Minimal resolver contract accepted by the composite `akv:` scheme. */
export interface SecretValueResolver {
  /** Resolves a reference to a value that can be explicitly revealed. */
  resolve(ref: SecretRef, signal?: AbortSignal): Promise<{ reveal(): string }>;
}

/** Warning emitted when a POSIX secret file can be read by all users. */
export type SecretFileWarningCode = "secret_file_permissions";

/** Receives file permission warning codes without secret values or file paths. */
export type SecretFileWarningHandler = (code: SecretFileWarningCode) => void;

/** A file status containing the mode bits used for the permissions check. */
export interface SecretFileStatus {
  readonly mode: number;
}

/** Injectable file operations and warning handler for file-backed secrets. */
export interface FileSecretResolverOptions {
  /** Reads a file as UTF-8 text and honors an optional cancellation signal. */
  readonly readFile?: (path: string, signal?: AbortSignal) => Promise<string>;
  /** Reads file status before the file contents are loaded. */
  readonly stat?: (path: string) => Promise<SecretFileStatus>;
  /** Platform used to decide whether POSIX permission bits apply. */
  readonly platform?: NodeJS.Platform;
  /** Receives the warning code while resolution continues. */
  readonly onWarning?: SecretFileWarningHandler;
}

function requireReference(ref: SecretRef, scheme: "env" | "file"): string {
  const parsed = SecretRefSchema.safeParse(ref);
  if (!parsed.success) {
    throw new SecretResolutionError("secret_ref_invalid");
  }
  if (!parsed.data.startsWith(`${scheme}:`)) {
    throw new SecretResolutionError("secret_resolver_unavailable");
  }
  return parsed.data.slice(scheme.length + 1);
}

function isFileNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) {
    throw new SecretResolutionError("secret_resolution_cancelled");
  }
}

/** Resolves `env:NAME` references from an injected or process environment. */
export class EnvSecretResolver implements SecretResolver {
  /**
   * Creates an environment resolver.
   *
   * @param env - Environment source; defaults to `process.env`.
   */
  constructor(private readonly env: Readonly<Record<string, string | undefined>> = process.env) {}

  /** Resolves an environment variable or throws a safe resolver error. */
  resolve(ref: SecretRef, signal?: AbortSignal): Promise<Secret> {
    return Promise.resolve().then(() => {
      throwIfAborted(signal);
      const name = requireReference(ref, "env");
      const value = Object.hasOwn(this.env, name) ? this.env[name] : undefined;
      if (value === undefined) {
        throw new SecretResolutionError("secret_not_found");
      }
      return new Secret(value);
    });
  }
}

/** Resolves `file:/absolute/path` references into secret values. */
export class FileSecretResolver implements SecretResolver {
  private readonly readFile: (path: string, signal?: AbortSignal) => Promise<string>;
  private readonly stat: (path: string) => Promise<SecretFileStatus>;
  private readonly platform: NodeJS.Platform;
  private readonly onWarning: SecretFileWarningHandler;

  /**
   * Creates a file resolver with optional injectable I/O and warning handling.
   *
   * @param options - File operations, platform, and permission-warning handler.
   */
  constructor(options: FileSecretResolverOptions = {}) {
    this.readFile =
      options.readFile ??
      ((path, signal) =>
        readFileFromDisk(path, {
          encoding: "utf8",
          ...(signal === undefined ? {} : { signal }),
        }));
    this.stat = options.stat ?? statFromDisk;
    this.platform = options.platform ?? process.platform;
    this.onWarning = options.onWarning ?? (() => undefined);
  }

  /** Resolves a file reference, trimming one newline and honoring cancellation. */
  async resolve(ref: SecretRef, signal?: AbortSignal): Promise<Secret> {
    throwIfAborted(signal);
    const path = requireReference(ref, "file");
    let status: SecretFileStatus;
    let value: string;
    try {
      status = await this.stat(path);
      throwIfAborted(signal);
      value = await this.readFile(path, signal);
      throwIfAborted(signal);
    } catch (error) {
      throwIfAborted(signal);
      throw new SecretResolutionError(
        isFileNotFound(error) ? "secret_not_found" : "secret_resolver_unavailable",
      );
    }

    if (this.platform !== "win32" && (status.mode & 0o004) !== 0) {
      this.onWarning("secret_file_permissions");
    }
    return new Secret(value.replace(/\r?\n$/, ""));
  }
}

/** Resolvers used for environment and file references. */
export interface CompositeSecretResolverOptions {
  /** Resolver for `env:` references. */
  readonly env?: SecretResolver;
  /** Resolver for `file:` references. */
  readonly file?: SecretResolver;
  /** Resolver for `akv:` references, injected to avoid a config-to-vault dependency. */
  readonly akv?: SecretValueResolver;
}

/** Dispatches secret references to environment, file, or injected Key Vault resolvers. */
export class CompositeSecretResolver implements SecretResolver {
  private readonly envResolver: SecretResolver;
  private readonly fileResolver: SecretResolver;
  private readonly akvResolver: SecretValueResolver | undefined;

  /**
   * Creates a resolver with optional scheme-specific implementations.
   *
   * @param options - Environment and file resolver overrides.
   */
  constructor(options: CompositeSecretResolverOptions = {}) {
    this.envResolver = options.env ?? new EnvSecretResolver();
    this.fileResolver = options.file ?? new FileSecretResolver();
    this.akvResolver = options.akv;
  }

  /** Resolves the scheme-specific secret reference and returns a redacting Secret. */
  async resolve(ref: SecretRef, signal?: AbortSignal): Promise<Secret> {
    throwIfAborted(signal);
    const parsed = SecretRefSchema.safeParse(ref);
    if (!parsed.success) {
      throw new SecretResolutionError("secret_ref_invalid");
    }
    if (parsed.data.startsWith("env:")) {
      return this.envResolver.resolve(parsed.data, signal);
    }
    if (parsed.data.startsWith("file:")) {
      return this.fileResolver.resolve(parsed.data, signal);
    }
    if (parsed.data.startsWith("akv:") && this.akvResolver !== undefined) {
      return new Secret((await this.akvResolver.resolve(parsed.data, signal)).reveal());
    }
    throw new SecretResolutionError("secret_resolver_unavailable");
  }
}
