// SPDX-License-Identifier: Apache-2.0
/** English UI copy shared by every harness MCP App view. */
export const stringCatalog = {
  en: {
    approvalTitle: "Pending approval",
    waitingHeading: "Waiting for approval",
    waitingStatus: "Waiting for host...",
    pendingStatus: "Pending approval",
    expiredStatus: "Approval expired",
    invalidHeading: "Approval unavailable",
    invalidStatus: "Invalid approval payload",
    unavailableId: "Approval identifier unavailable.",
    approvalGranted: "Approval granted.",
    approvalDenied: "Approval denied.",
    editsSubmitted: "Edits submitted.",
    tool: "Tool",
    rule: "Rule",
    reason: "Reason",
    expiry: "Expiry",
    noExpiry: "No expiry",
    secondsRemaining: "{seconds} seconds remaining",
    arguments: "Arguments",
    approvalActions: "Approval actions",
    argumentValue: "{label}: ",
    argumentObject: "{label} (object{empty})",
    argumentArray: "{label} (array, {count} {items}{empty})",
    oneItem: "item",
    manyItems: "items",
    emptySuffix: ", empty",
    approve: "Approve",
    deny: "Deny",
    edit: "Edit",
    submitEdits: "Submit edits",
    cancel: "Cancel",
    editApproval: "Edit approval",
    allArguments: "All arguments",
    currentTokenizedValue: "Current tokenized value: {value}",
    notSet: "(not set)",
    validValueRequired: "Enter a valid value.",
    submittingDecision: "Submitting decision.",
    noChanges: "No changes to submit.",
    editingApproval: "Editing approval.",
    errorApprovalMissing: "This approval could not be found.",
    errorAlreadyResolved: "This approval has already been resolved.",
    errorRunNotSuspended: "This run is no longer awaiting approval.",
    errorResolutionConflict: "The approval could not be resolved. Try again.",
    errorInvalidEdit: "The edited values are invalid.",
    errorEditNotAllowed: "One or more edited fields are not allowed.",
    errorResolve: "The approval could not be resolved.",
    errorReveal: "The values could not be revealed.",
    useCommandLine: "Use the command line",
    approveCommand: "Approve",
    denyCommand: "Deny",
    copyCommand: "Copy command",
    commandCopied: "Command copied.",
    copyUnavailable: "Copy unavailable. The command is selected for manual copying.",
    commandLabel: "{label} command",
    copyCommandLabel: "Copy {label} command",
    fallbackUnavailable: "The host bridge is unavailable. Resolve this approval from the CLI.",
    approveCliCommand: "harness approvals approve {id}",
    denyCliCommand: "harness approvals deny {id}",
    revealValues: "Reveal values",
    revealConfirmation: "Show raw values for {count} fields? This is logged.",
    showRawValues: "Show raw values",
    revealingValues: "Revealing values.",
    revealedFor: "Values revealed for 30 seconds.",
    hiddenValues: "Sensitive values hidden.",
    tokenLabel: "{type} {index}",
    tableNavigation: "Table: {label}",
    runsConsoleTitle: "Runs",
    runsConsoleDescription: "Run status and metadata",
    runStatusFilter: "Filter by status",
    allRunStatuses: "All statuses",
    refreshRuns: "Refresh runs",
    loadMoreRuns: "Load more runs",
    loadingMoreRuns: "Loading more runs.",
    runId: "Run ID",
    runStatus: "Status",
    runAge: "Age",
    runSteps: "Steps",
    runApprovals: "Pending approvals",
    viewRunDetails: "View details",
    needsApproval: "Needs approval ({count})",
    openApproval: "Open approval {id}",
    noRunsTitle: "No runs found",
    noRunsMessage: "There are no runs matching this status.",
    runDetailsTitle: "Run details",
    runDetailStatus: "Status",
    runDetailSteps: "Steps",
    runDetailInputTokens: "Input tokens",
    runDetailOutputTokens: "Output tokens",
    runDetailCost: "Cost (micros)",
    runDetailApprovals: "Pending approvals",
    runsLoading: "Loading runs.",
    runsUpdated: "Run list updated.",
    runsUnavailable: "Run metadata is temporarily unavailable.",
    emptyTitle: "Nothing to show",
    emptyMessage: "There are no items to display.",
    errorTitle: "Something went wrong",
    errorMessage: "This view is temporarily unavailable.",
    confirm: "Confirm",
  },
} as const;

/** Locale identifiers currently available in the app string catalog. */
export type UiLocale = keyof typeof stringCatalog;
/** Inferred UI copy shape shared across all views. */
export type UiStrings = (typeof stringCatalog)[UiLocale];

/** Returns the supported catalog for a host locale, falling back to English. */
export function getStrings(_locale: string | undefined): UiStrings {
  return stringCatalog.en;
}

/** Formats a numeric value using the host locale, with a stable English fallback. */
export function formatNumber(value: number, locale: string | undefined): string {
  try {
    return new Intl.NumberFormat(locale ?? "en").format(value);
  } catch {
    return new Intl.NumberFormat("en").format(value);
  }
}

/** Formats a timestamp using the host locale and time zone. */
export function formatDate(
  value: number,
  locale: string | undefined,
  timeZone: string | undefined,
): string {
  try {
    return new Intl.DateTimeFormat(locale ?? "en", {
      dateStyle: "medium",
      timeStyle: "short",
      ...(timeZone === undefined ? {} : { timeZone }),
    }).format(new Date(value));
  } catch {
    return new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(
      new Date(value),
    );
  }
}

/** Formats elapsed milliseconds with the host locale. */
export function formatDuration(valueMs: number, locale: string | undefined): string {
  return `${formatNumber(valueMs, locale)} ms`;
}

/** Replaces named placeholders in a catalog string without interpreting markup. */
export function formatMessage(
  message: string,
  values: Readonly<Record<string, string | number>>,
  locale?: string,
): string {
  return message.replaceAll(/\{([a-z]+)\}/giu, (placeholder, key: string) => {
    const value = values[key];
    if (value === undefined) {
      return placeholder;
    }
    if (typeof value === "number") {
      return formatNumber(value, locale);
    }
    return value;
  });
}
