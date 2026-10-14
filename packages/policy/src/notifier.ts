// SPDX-License-Identifier: Apache-2.0
import { HarnessError, Id, Code, type SecretRef, SecretRefSchema } from "@harness/schemas";
import { z } from "zod";

const WebhookUrlSchema = z.url().refine((value) => {
  const url = new URL(value);
  return (
    (url.protocol === "https:" || (url.protocol === "http:" && url.hostname === "localhost")) &&
    url.username.length === 0 &&
    url.password.length === 0
  );
});

/** Strict metadata-only body shared by approval notification implementations. */
export const ApprovalNotificationSchema = z
  .object({
    runId: Id,
    approvalId: Id,
    idempotencyKey: Id,
    toolId: Code,
    ruleId: Code,
    ageMs: z.number().int().nonnegative(),
  })
  .strict()
  .refine(({ approvalId, idempotencyKey }) => idempotencyKey === approvalId);

/** Metadata delivered when a pending approval reaches its escalation threshold. */
export type ApprovalNotification = z.infer<typeof ApprovalNotificationSchema>;

/** Sends a metadata-only notification for an approval that is waiting too long. */
export interface Notifier {
  /** Notify a human about the pending approval. */
  notify(notification: ApprovalNotification): Promise<void>;
}

/** Writes validated notification metadata to an injected log sink. */
export class LogNotifier implements Notifier {
  /** Creates a notifier that writes only validated metadata to the supplied sink. */
  constructor(private readonly write: (notification: ApprovalNotification) => void) {}

  /** {@inheritDoc Notifier.notify} */
  notify(notification: ApprovalNotification): Promise<void> {
    const validated = ApprovalNotificationSchema.parse(notification);
    return Promise.resolve().then(() => {
      this.write(validated);
    });
  }
}

/** Resolves a SecretRef to an in-memory URL without exposing the value to logs. */
export interface WebhookSecretResolver {
  /** Resolve the secret value, respecting the supplied per-attempt timeout signal. */
  resolve(ref: SecretRef, signal: AbortSignal): Promise<string>;
}

/** Dependencies for a metadata-only webhook notifier. */
export type WebhookNotifierOptions = {
  /** Resolver for webhook authorization secrets or a legacy URL SecretRef. */
  readonly secrets: WebhookSecretResolver;
  /** Fetch implementation, injectable for tests. */
  readonly fetch?: typeof globalThis.fetch;
  /** Maximum duration of each delivery attempt. */
  readonly timeoutMs?: number;
  /** Allows HTTP only for localhost destinations. */
  readonly allowInsecureLocalhost?: boolean;
} &
  (
    | { readonly url: string; readonly secretRef: SecretRef }
    | { readonly url: SecretRef; readonly secretRef?: never }
  );

/** Error raised when a webhook notification cannot be delivered. */
export class WebhookNotificationError extends HarnessError {
  readonly code = "approval_webhook_failed";

  /** Creates a value-free webhook delivery error. */
  constructor() {
    super("Approval webhook delivery failed.");
    this.name = "WebhookNotificationError";
  }
}

function parseWebhookUrl(value: string, allowInsecureLocalhost: boolean): string {
  const result = WebhookUrlSchema.safeParse(value);
  if (!result.success) {
    throw new WebhookNotificationError();
  }
  const url = new URL(result.data);
  if (url.protocol === "http:" && (!allowInsecureLocalhost || url.hostname !== "localhost")) {
    throw new WebhookNotificationError();
  }
  return url.href;
}

/** Posts metadata-only approval notifications to a configured or secret-resolved URL. */
export class WebhookNotifier implements Notifier {
  private readonly endpoint: string | undefined;
  private readonly urlSecretRef: SecretRef | undefined;
  private readonly secretRef: SecretRef | undefined;
  private readonly secrets: WebhookSecretResolver;
  private readonly fetcher: typeof globalThis.fetch;
  private readonly timeoutMs: number;

  /** Creates a notifier with an injected secret resolver and optional fetch implementation. */
  constructor(options: WebhookNotifierOptions) {
    this.secretRef =
      options.secretRef === undefined ? undefined : SecretRefSchema.parse(options.secretRef);
    this.urlSecretRef =
      this.secretRef === undefined ? SecretRefSchema.parse(options.url) : undefined;
    this.endpoint =
      this.secretRef === undefined
        ? undefined
        : parseWebhookUrl(options.url, options.allowInsecureLocalhost === true);
    this.secrets = options.secrets;
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 5_000;
  }

  /** {@inheritDoc Notifier.notify} */
  async notify(notification: ApprovalNotification): Promise<void> {
    const validated = ApprovalNotificationSchema.parse(notification);
    const body = JSON.stringify(validated);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const signal = AbortSignal.timeout(this.timeoutMs);
        const url =
          this.urlSecretRef === undefined
            ? this.endpoint
            : parseWebhookUrl(await this.secrets.resolve(this.urlSecretRef, signal), false);
        const authorization =
          this.secretRef === undefined
            ? undefined
            : await this.secrets.resolve(this.secretRef, signal);
        if (url === undefined) {
          throw new WebhookNotificationError();
        }
        const response = await this.fetcher(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "Idempotency-Key": validated.idempotencyKey,
            ...(authorization === undefined ? {} : { authorization: "Bearer " + authorization }),
          },
          body,
          signal,
          redirect: "error",
        });
        if (response.ok) {
          return;
        }
      } catch {
        if (attempt === 1) {
          throw new WebhookNotificationError();
        }
      }
    }
    throw new WebhookNotificationError();
  }
}
