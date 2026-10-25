// SPDX-License-Identifier: Apache-2.0
import { Code } from "@rovinos/schemas";
import type { ControlPlanePrincipal } from "../auth.js";
import { describe, expect, it, vi } from "vitest";
import {
  notifyPrincipalResourceUpdates,
  isRunSubscriptionAuthorized,
  runIdFromResourceUri,
} from "./run-resource-access.js";
import { RUNS_RESOURCE_URI, RUN_RESOURCE_URI_TEMPLATE } from "./runs.js";

const allowedRunId = "00000000000000000000000001";
const otherRunId = "00000000000000000000000002";
const restrictedPrincipal: ControlPlanePrincipal = {
  tokenId: Code.parse("restricted.token"),
  scopes: [],
  runIds: [allowedRunId],
};

function subscriptionBody(uri: string): string {
  return JSON.stringify({
    method: "subscriptions/listen",
    params: { notifications: { resourceSubscriptions: [uri] } },
  });
}

describe("run resource access", () => {
  it("authorizes own runs and the list resource, but rejects other or malformed run URIs", () => {
    const allowedUri = RUN_RESOURCE_URI_TEMPLATE.replace("{runId}", allowedRunId);
    const deniedUri = RUN_RESOURCE_URI_TEMPLATE.replace("{runId}", otherRunId);
    expect(isRunSubscriptionAuthorized(subscriptionBody(allowedUri), restrictedPrincipal)).toBe(
      true,
    );
    expect(
      isRunSubscriptionAuthorized(subscriptionBody(RUNS_RESOURCE_URI), restrictedPrincipal),
    ).toBe(true);
    expect(isRunSubscriptionAuthorized(subscriptionBody(deniedUri), restrictedPrincipal)).toBe(
      false,
    );
    expect(
      isRunSubscriptionAuthorized(
        subscriptionBody(RUN_RESOURCE_URI_TEMPLATE.replace("{runId}", "bad")),
        restrictedPrincipal,
      ),
    ).toBe(false);
    expect(isRunSubscriptionAuthorized("{", restrictedPrincipal)).toBe(true);
    expect(
      isRunSubscriptionAuthorized(subscriptionBody(deniedUri), {
        ...restrictedPrincipal,
        runIds: undefined,
      }),
    ).toBe(true);
  });

  it("extracts only valid run resource identifiers", () => {
    expect(runIdFromResourceUri(RUN_RESOURCE_URI_TEMPLATE.replace("{runId}", allowedRunId))).toBe(
      allowedRunId,
    );
    expect(runIdFromResourceUri(RUNS_RESOURCE_URI)).toBeUndefined();
    expect(
      runIdFromResourceUri(RUN_RESOURCE_URI_TEMPLATE.replace("{runId}", "bad")),
    ).toBeUndefined();
  });

  it("notifies unrestricted principals for all runs and restricted principals only for owned runs", () => {
    const unrestricted = vi.fn();
    const restricted = vi.fn();
    const unrestrictedPrincipal: ControlPlanePrincipal = {
      tokenId: Code.parse("unrestricted.token"),
      scopes: [],
    };
    const handlers = new Map([
      [unrestrictedPrincipal.tokenId, { notify: { resourceUpdated: unrestricted } }],
      [restrictedPrincipal.tokenId, { notify: { resourceUpdated: restricted } }],
    ]);
    const tokens = [{ principal: unrestrictedPrincipal }, { principal: restrictedPrincipal }];
    const allowedUri = RUN_RESOURCE_URI_TEMPLATE.replace("{runId}", allowedRunId);
    const deniedUri = RUN_RESOURCE_URI_TEMPLATE.replace("{runId}", otherRunId);

    notifyPrincipalResourceUpdates(tokens, handlers, deniedUri);
    expect(unrestricted).toHaveBeenCalledWith(deniedUri);
    expect(restricted).not.toHaveBeenCalled();
    notifyPrincipalResourceUpdates(tokens, handlers, allowedUri);
    expect(restricted).toHaveBeenNthCalledWith(1, allowedUri);
    expect(restricted).toHaveBeenNthCalledWith(2, RUNS_RESOURCE_URI);
  });
});
