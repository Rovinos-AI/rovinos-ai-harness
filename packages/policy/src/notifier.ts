// SPDX-License-Identifier: Apache-2.0
import { HarnessError, Id, Code, type SecretRef, SecretRefSchema } from "@harness/schemas";
import { z } from "zod";

const WebhookUrlSchema = z.url().refine((value) => {
  const url = new URL(value);
  return (
    ["https:", "http:"].includes(url.protocol) &&
    url.username.length === 0 &&
    url.password.length === 0
  );
});

/** Strict metadata-only body shared by approval notification implementations. */
export const ApprovalNotificationSchema = z
  .object({
    runId: Id,
    approvalId: Id,
    toolId: Code,
    ruleId: Code,
    ageMs: z.number().int().nonnegative(),
  })
  .strict();

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
export interface WebhookNotifierOptions {
  /** SecretRef whose value is the webhook URL. */
  readonly url: SecretRef;
  /** Resolver for the webhook URL SecretRef. */
  readonly secrets: WebhookSecretResolver;
  /** Fetch implementation, injectable for tests. */
  readonly fetch?: typeof globalThis.fetch;
}

/** Error raised when a webhook notification cannot be delivered. */
export class WebhookNotificationError extends HarnessError {
  readonly code = "approval_webhook_failed";

  /** Creates a value-free webhook delivery error. */
  constructor() {
    super("Approval webhook delivery failed.");
    this.name = "WebhookNotificationError";
  }
}

function parseWebhookUrl(value: string): string {
  const result = WebhookUrlSchema.safeParse(value);
  if (!result.success) {
    throw new WebhookNotificationError();
  }
  return new URL(result.data).href;
}

/** Posts metadata-only approval notifications to a URL resolved from a SecretRef. */
export class WebhookNotifier implements Notifier {
  private readonly url: SecretRef;
  private readonly secrets: WebhookSecretResolver;
  private readonly fetcher: typeof globalThis.fetch;

  /** Creates a notifier with an injected secret resolver and optional fetch implementation. */
  constructor(options: WebhookNotifierOptions) {
    this.url = SecretRefSchema.parse(options.url);
    this.secrets = options.secrets;
    this.fetcher = options.fetch ?? globalThis.fetch;
  }

  /** {@inheritDoc Notifier.notify} */
  async notify(notification: ApprovalNotification): Promise<void> {
    const body = JSON.stringify(ApprovalNotificationSchema.parse(notification));
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const signal = AbortSignal.timeout(5_000);
        const url = parseWebhookUrl(await this.secrets.resolve(this.url, signal));
        const response = await this.fetcher(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
          signal,
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
