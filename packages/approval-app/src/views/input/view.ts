// SPDX-License-Identifier: Apache-2.0
import {
  InputAppInputSchema,
  InputAppListSchema,
  type InputAnswerRequest,
  type InputAppInput,
} from "@rovinos/schemas/browser";
import {
  appendTokenText,
  createConfirmationDialog,
  createErrorState,
  createFormFromSchema,
  getRegistrableDomain,
  createUrlDisplay,
} from "../../kit/components.js";
import { formatMessage, getStrings } from "../../kit/strings.js";

type InputStrings = ReturnType<typeof getStrings>;
type InputAction = "accept" | "decline" | "cancel" | "open_link" | "done";
type AnswerSubmitter = (request: InputAnswerRequest, telemetryAction?: InputAction) => void;

/** Callbacks and host context needed to render and resolve a human input request. */
export interface InputViewOptions {
  readonly locale?: () => string;
  readonly onAnswer: (request: InputAnswerRequest) => Promise<boolean>;
  readonly onInputAction: (action: InputAction) => void;
  readonly onOpenLink: (url: string) => Promise<boolean>;
  readonly onSelect: (requestId: string) => void;
  readonly onError: (code: "payload_invalid") => void;
}

/** Mounted input view methods for receiving bridge data and releasing DOM resources. */
export interface InputView {
  receive(value: unknown): boolean;
  dispose(): void;
}

function element<K extends keyof HTMLElementTagNameMap>(
  document: Document,
  tag: K,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text !== undefined) {
    node.textContent = text;
  }
  return node;
}

function requester(input: InputAppInput, strings: ReturnType<typeof getStrings>): string {
  if (input.source === "agent") {
    return strings.inputAgent;
  }
  return input.serverId ?? strings.mcpServer;
}

function registrableDomain(url: string): string {
  try {
    return getRegistrableDomain(new URL(url).hostname);
  } catch {
    return url;
  }
}

function hasSuspiciousHost(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol !== "https:" ||
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.hostname === "localhost" ||
      parsed.hostname.endsWith(".localhost") ||
      parsed.hostname.startsWith("xn--") ||
      parsed.hostname.includes(".xn--") ||
      /^\d{1,3}(?:\.\d{1,3}){3}$/u.test(parsed.hostname) ||
      parsed.hostname.includes(":")
    );
  } catch {
    return true;
  }
}

function canOpenLink(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      (parsed.protocol === "https:" || parsed.protocol === "http:") &&
      parsed.username === "" &&
      parsed.password === "" &&
      parsed.hostname !== ""
    );
  } catch {
    return false;
  }
}

function addAnswerActions(
  root: HTMLElement,
  strings: InputStrings,
  options: {
    readonly requestId: string;
    readonly labels: readonly { readonly label: string; readonly action: "decline" | "cancel" }[];
    readonly onSubmit: AnswerSubmitter;
  },
): void {
  const actions = element(root.ownerDocument, "nav");
  actions.setAttribute("aria-label", strings.inputActions);
  for (const { label, action } of options.labels) {
    const button = element(root.ownerDocument, "button", label);
    button.type = "button";
    button.addEventListener("click", () => {
      options.onSubmit({ requestId: options.requestId, action });
    });
    actions.append(button);
  }
  root.append(actions);
}

function setControlsDisabled(main: HTMLElement, disabled: boolean): void {
  for (const control of main.querySelectorAll<
    HTMLButtonElement | HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
  >("button, input, select, textarea")) {
    control.disabled = disabled;
  }
}

function resolveStatus(action: InputAnswerRequest["action"], strings: InputStrings): string {
  switch (action) {
    case "accept":
      return strings.inputAccepted;
    case "decline":
      return strings.inputDeclined;
    case "cancel":
      return strings.inputCancelled;
  }
}

function createAnswerSubmitter(options: {
  readonly main: HTMLElement;
  readonly status: HTMLElement;
  readonly strings: InputStrings;
  readonly viewOptions: InputViewOptions;
}): AnswerSubmitter {
  const { main, status, strings, viewOptions } = options;
  return (request, telemetryAction = request.action) => {
    viewOptions.onInputAction(telemetryAction);
    setControlsDisabled(main, true);
    status.textContent = strings.inputSubmitting;
    const showFailure = (): void => {
      status.textContent = strings.inputResolveFailed;
      setControlsDisabled(main, false);
    };
    void viewOptions.onAnswer(request).then((resolved) => {
      if (resolved) {
        status.textContent = resolveStatus(request.action, strings);
        return;
      }
      showFailure();
    }, showFailure);
  };
}

function renderFormInput(options: {
  readonly main: HTMLElement;
  readonly input: InputAppInput;
  readonly strings: InputStrings;
  readonly submitAnswer: AnswerSubmitter;
}): void {
  const { main, input, strings, submitAnswer } = options;
  const document = main.ownerDocument;
  if (input.schema !== undefined) {
    const form = createFormFromSchema(document, input.schema, (answer) => {
      submitAnswer({ requestId: input.requestId, action: "accept", answer });
    });
    form.setAttribute("aria-label", strings.inputForm);
    main.append(form);
  } else {
    const form = element(document, "form");
    form.setAttribute("aria-label", strings.inputForm);
    const label = element(document, "label", strings.inputForm);
    const response = element(document, "textarea");
    response.name = "response";
    response.required = true;
    response.id = `input-response-${input.requestId}`;
    label.htmlFor = response.id;
    const accept = element(document, "button", strings.accept);
    accept.type = "submit";
    form.append(label, response, accept);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (response.value.trim() !== "") {
        submitAnswer({
          requestId: input.requestId,
          action: "accept",
          answer: response.value,
        });
      }
    });
    main.append(form);
  }
  addAnswerActions(main, strings, {
    requestId: input.requestId,
    labels: [
      { label: strings.decline, action: "decline" },
      { label: strings.cancelInput, action: "cancel" },
    ],
    onSubmit: submitAnswer,
  });
}

function renderUrlInput(options: {
  readonly main: HTMLElement;
  readonly input: InputAppInput;
  readonly status: HTMLElement;
  readonly strings: InputStrings;
  readonly viewOptions: InputViewOptions;
  readonly submitAnswer: AnswerSubmitter;
}): void {
  const url = options.input.url;
  if (url === undefined) {
    return;
  }
  const { main, input, status, strings, viewOptions, submitAnswer } = options;
  const document = main.ownerDocument;
  const urlSection = element(document, "section");
  urlSection.append(element(document, "h2", strings.inputUrl));
  const urlText = createUrlDisplay(document, url);
  urlText.setAttribute("aria-label", strings.inputUrl);
  urlSection.append(urlText);
  if (hasSuspiciousHost(url)) {
    const warning = element(document, "p", strings.suspiciousHost);
    warning.className = "status-badge status-warning";
    warning.setAttribute("role", "note");
    urlSection.append(warning);
  }
  const open = element(document, "button", strings.openLink);
  open.type = "button";
  open.disabled = !canOpenLink(url);
  const confirmation = createConfirmationDialog(document, {
    title: strings.confirmOpenLinkTitle,
    message: formatMessage(strings.confirmOpenLink, { domain: registrableDomain(url) }),
    confirmLabel: strings.openLink,
    cancelLabel: strings.cancelInput,
    onConfirm: () => {
      open.disabled = true;
      void viewOptions.onOpenLink(url).then(
        (opened) => {
          if (opened) {
            status.textContent = strings.urlOpened;
            const done = element(document, "button", strings.inputDone);
            done.type = "button";
            done.addEventListener("click", () => {
              submitAnswer({ requestId: input.requestId, action: "accept" }, "done");
            });
            urlSection.append(done);
            return;
          }
          status.textContent = strings.linkRequestDenied;
          open.disabled = false;
        },
        () => {
          status.textContent = strings.linkRequestDenied;
          open.disabled = false;
        },
      );
    },
  });
  open.addEventListener("click", () => {
    if (typeof confirmation.showModal === "function") {
      confirmation.showModal();
    }
  });
  urlSection.append(open, confirmation);
  main.append(urlSection);
  addAnswerActions(main, strings, {
    requestId: input.requestId,
    labels: [{ label: strings.cancelInput, action: "cancel" }],
    onSubmit: submitAnswer,
  });
}

function renderInput(
  root: HTMLElement,
  input: InputAppInput,
  options: InputViewOptions,
  strings: InputStrings,
): void {
  const main = element(root.ownerDocument, "main");
  const heading = element(
    root.ownerDocument,
    "h1",
    formatMessage(strings.inputFrom, { source: requester(input, strings) }),
  );
  heading.tabIndex = -1;
  const status = element(root.ownerDocument, "p");
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  const message = element(root.ownerDocument, "section");
  message.setAttribute("aria-label", strings.inputMessage);
  const messageText = element(root.ownerDocument, "p");
  message.append(element(root.ownerDocument, "h2", strings.inputMessage), messageText);
  appendTokenText(messageText, input.message);
  main.append(heading, status, message);
  const submitAnswer = createAnswerSubmitter({ main, status, strings, viewOptions: options });
  if (input.mode === "form") {
    renderFormInput({ main, input, strings, submitAnswer });
  } else {
    renderUrlInput({ main, input, status, strings, viewOptions: options, submitAnswer });
  }
  root.replaceChildren(main);
  heading.focus();
}

function renderList(
  root: HTMLElement,
  inputs: ReturnType<typeof InputAppListSchema.parse>["inputs"],
  options: InputViewOptions,
  strings: ReturnType<typeof getStrings>,
): void {
  const document = root.ownerDocument;
  const main = element(document, "main");
  const heading = element(document, "h1", strings.inputListTitle);
  heading.tabIndex = -1;
  const list = element(document, "ul");
  for (const input of inputs) {
    const item = element(document, "li");
    const source =
      input.source === "agent" ? strings.inputAgent : (input.serverId ?? strings.mcpServer);
    const button = element(document, "button", formatMessage(strings.openInput, { source }));
    button.type = "button";
    button.addEventListener("click", () => {
      options.onSelect(input.requestId);
    });
    item.append(button);
    list.append(item);
  }
  if (inputs.length === 0) {
    list.append(element(document, "li", strings.inputListEmpty));
  }
  main.append(heading, list);
  root.replaceChildren(main);
  heading.focus();
}

/** Mounts an input form or URL request using only validated bridge data and DOM text nodes. */
export function createInputView(root: HTMLElement, options: InputViewOptions): InputView {
  const strings = getStrings(options.locale?.() ?? root.ownerDocument.documentElement.lang);
  const initial = element(root.ownerDocument, "main");
  const heading = element(root.ownerDocument, "h1", strings.inputWaiting);
  heading.tabIndex = -1;
  initial.append(heading, element(root.ownerDocument, "p", strings.waitingStatus));
  root.replaceChildren(initial);
  heading.focus();

  return {
    receive(value: unknown): boolean {
      const input = InputAppInputSchema.safeParse(value);
      if (input.success) {
        renderInput(root, input.data, options, strings);
        return true;
      }
      const list = InputAppListSchema.safeParse(value);
      if (list.success) {
        renderList(root, list.data.inputs, options, strings);
        return true;
      }
      options.onError("payload_invalid");
      root.replaceChildren(createErrorState(root.ownerDocument, strings.inputInvalidStatus));
      return false;
    },
    dispose() {
      root.replaceChildren();
    },
  };
}
