// SPDX-License-Identifier: Apache-2.0
import type { HarnessConfig } from "@rovinos/config";
import type { ApprovalNotification, Notifier } from "@rovinos/policy";
import type { SecretRef } from "@rovinos/schemas";
import type { CliContext } from "../command.js";

type ApprovalNotifierConfig = NonNullable<HarnessConfig["policy"]["approvals"]>;
type LogWriter = (notification: ApprovalNotification) => void;

/** Creates the configured approval escalation notifier, defaulting to metadata-only logs. */
export async function createApprovalNotifier(
  config: ApprovalNotifierConfig | undefined,
  secretResolver: CliContext["secretResolver"],
  write: LogWriter,
): Promise<Notifier> {
  const { LogNotifier, WebhookNotificationError, WebhookNotifier } =
    await import("@rovinos/policy");
  const notifier = config?.notifier ?? { kind: "log" as const };
  if (notifier.kind === "log") {
    return new LogNotifier(write);
  }

  return new WebhookNotifier({
    url: notifier.url,
    secretRef: notifier.secretRef,
    ...(notifier.timeoutMs === undefined ? {} : { timeoutMs: notifier.timeoutMs }),
    allowInsecureLocalhost: config?.allowInsecureLocalhost ?? false,
    secrets: {
      resolve: async (ref: SecretRef, signal: AbortSignal) => {
        if (secretResolver === undefined) {
          throw new WebhookNotificationError();
        }
        return (await secretResolver.resolve(ref, signal)).reveal();
      },
    },
  });
}
