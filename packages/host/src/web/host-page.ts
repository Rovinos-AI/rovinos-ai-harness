// SPDX-License-Identifier: Apache-2.0
import {
  type McpUiHostContext,
  type McpUiRequestDisplayModeRequest,
} from "@modelcontextprotocol/ext-apps/app-bridge";
import { z } from "zod";
import { createHostContext } from "../server/host-context.js";
import { mountReferenceApp } from "./host-app.js";
import {
  clampAppSize,
  MAX_FRAME_HEIGHT,
  MAX_FRAME_WIDTH,
  type HostPagePort,
  type OpenLinkDetails,
} from "./host.js";

const DisplayModeSchema = z.enum(["inline", "fullscreen", "pip"]);
type DisplayMode = McpUiRequestDisplayModeRequest["params"]["mode"];

interface BrowserHostState {
  getFrame(): HTMLIFrameElement | undefined;
  setFrame(frame: HTMLIFrameElement): void;
  getDisplayMode(): "inline" | "fullscreen";
  setDisplayMode(mode: "inline" | "fullscreen"): void;
  isConsentPending(): boolean;
  setConsentPending(pending: boolean): void;
}

class MutableBrowserHostState implements BrowserHostState {
  #frame: HTMLIFrameElement | undefined;
  #displayMode: "inline" | "fullscreen" = "inline";
  #consentPending = false;

  getFrame(): HTMLIFrameElement | undefined {
    return this.#frame;
  }

  setFrame(frame: HTMLIFrameElement): void {
    this.#frame = frame;
  }

  getDisplayMode(): "inline" | "fullscreen" {
    return this.#displayMode;
  }

  setDisplayMode(mode: "inline" | "fullscreen"): void {
    this.#displayMode = mode;
  }

  isConsentPending(): boolean {
    return this.#consentPending;
  }

  setConsentPending(pending: boolean): void {
    this.#consentPending = pending;
  }
}

function readDimension(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

function readDisplayModes(): ("inline" | "fullscreen")[] {
  return document.fullscreenEnabled ? ["inline", "fullscreen"] : ["inline"];
}

function browserHostContext(element: HTMLElement, displayMode: string): McpUiHostContext {
  const dark =
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches;
  const width = Math.min(
    MAX_FRAME_WIDTH,
    readDimension(Reflect.get(element, "clientWidth"), readDimension(window.innerWidth, MAX_FRAME_WIDTH)),
    readDimension(window.innerWidth, MAX_FRAME_WIDTH),
  );
  const height = Math.min(
    MAX_FRAME_HEIGHT,
    readDimension(
      Reflect.get(element, "clientHeight"),
      readDimension(window.innerHeight, MAX_FRAME_HEIGHT),
    ),
    readDimension(window.innerHeight, MAX_FRAME_HEIGHT),
  );
  const locale =
    typeof navigator !== "undefined" && navigator.language.length > 0 ? navigator.language : "en";
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const modes = readDisplayModes();
  const requestedMode = DisplayModeSchema.safeParse(displayMode);
  const actualMode =
    requestedMode.success && modes.some((mode) => mode === requestedMode.data)
      ? requestedMode.data
      : "inline";
  return createHostContext({
    theme: dark ? "dark" : "light",
    locale,
    timeZone: timeZone.length > 0 ? timeZone : "UTC",
    displayMode: actualMode,
    availableDisplayModes: modes,
    maxWidth: width,
    maxHeight: height,
  });
}

function createConsentDialog(details: OpenLinkDetails): HTMLDialogElement {
  const dialog = document.createElement("dialog");
  dialog.setAttribute("aria-labelledby", "app-link-title");
  dialog.setAttribute("aria-modal", "true");
  const heading = document.createElement("h2");
  heading.id = "app-link-title";
  heading.textContent = "Open external link?";
  const destination = document.createElement("p");
  destination.append(document.createTextNode("Destination: "));
  const domain = document.createElement("strong");
  domain.className = "registrable-domain";
  domain.textContent = details.registrableDomain;
  destination.append(domain);
  const fullUrl = document.createElement("p");
  fullUrl.textContent = `Full URL: ${details.url}`;
  dialog.append(heading, destination, fullUrl);
  if (details.punycodeWarning) {
    const warning = document.createElement("p");
    warning.setAttribute("role", "alert");
    warning.textContent = "Warning: this URL contains an internationalized punycode domain.";
    dialog.append(warning);
  }
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.textContent = "Cancel";
  cancel.dataset.action = "cancel";
  const open = document.createElement("button");
  open.type = "button";
  open.textContent = "Open in browser";
  open.dataset.action = "open";
  const actions = document.createElement("div");
  actions.append(cancel, open);
  dialog.append(actions);
  return dialog;
}

function confirmOpenLink(
  details: OpenLinkDetails,
  state: BrowserHostState,
  openExternalLink: (url: string) => boolean,
): Promise<boolean> {
  if (state.isConsentPending()) {
    return Promise.resolve(false);
  }
  state.setConsentPending(true);
  return new Promise((resolve) => {
    const dialog = createConsentDialog(details);
    const finish = (approved: boolean): void => {
      dialog.close();
      dialog.remove();
      state.setConsentPending(false);
      resolve(approved);
    };
    dialog.addEventListener(
      "click",
      (event) => {
        if (!(event.target instanceof Element)) {
          return;
        }
        const action = event.target.closest("button")?.dataset.action;
        if (action === "open") {
          finish(openExternalLink(details.url));
        } else if (action === "cancel") {
          finish(false);
        }
      },
      { once: false },
    );
    dialog.addEventListener(
      "cancel",
      (event) => {
        event.preventDefault();
        finish(false);
      },
      { once: true },
    );
    dialog.addEventListener(
      "click",
      (event) => {
        if (event.target === dialog) {
          finish(false);
        }
      },
      { once: false },
    );
    document.body.append(dialog);
    dialog.showModal();
  });
}

function setDisplayMode(
  element: HTMLElement,
  state: BrowserHostState,
  notify: () => void,
  mode: DisplayMode,
): Promise<DisplayMode> {
  const available = readDisplayModes();
  if (mode === "pip" || !available.some((availableMode) => availableMode === mode)) {
    return Promise.resolve(state.getDisplayMode());
  }
  return (async () => {
    try {
      if (mode === "fullscreen" && document.fullscreenElement !== element) {
        await element.requestFullscreen();
      } else if (mode === "inline" && document.fullscreenElement === element) {
        await document.exitFullscreen();
      }
      state.setDisplayMode(mode);
      notify();
    } catch {
      return state.getDisplayMode();
    }
    return state.getDisplayMode();
  })();
}

function createHostPagePort(element: HTMLElement): {
  readonly root: HostPagePort;
  readonly notifyContextChange: () => void;
} {
  const state: BrowserHostState = new MutableBrowserHostState();
  const pageElement = element;
  const listeners = new Set<(context: McpUiHostContext) => void>();
  const notifyContextChange = (): void => {
      state.setDisplayMode(document.fullscreenElement === pageElement ? "fullscreen" : "inline");
      const context = browserHostContext(pageElement, state.getDisplayMode());
    for (const listener of listeners) {
      listener(context);
    }
  };
  const root: HostPagePort = {
    setStatus: (code) => {
      pageElement.textContent = code;
    },
    createFrame: () => {
      const frame = document.createElement("iframe");
      state.setFrame(frame);
      return frame;
    },
    attachFrame: () => {
      const frame = state.getFrame();
      if (frame !== undefined) {
        pageElement.replaceChildren(frame);
      }
    },
    getHostContext: () => browserHostContext(pageElement, state.getDisplayMode()),
    onHostContextChange: (callback) => {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
    confirmOpenLink: (details, open) => confirmOpenLink(details, state, open),
    resizeFrame: (width, height) => {
      const frame = state.getFrame();
      if (frame === undefined) {
        return;
      }
      const size = clampAppSize(width, height, MAX_FRAME_WIDTH, MAX_FRAME_HEIGHT);
      if (size.width !== undefined) {
        frame.style.width = `${String(size.width)}px`;
      }
      if (size.height !== undefined) {
        frame.style.height = `${String(size.height)}px`;
      }
    },
    setDisplayMode: (mode) => setDisplayMode(pageElement, state, notifyContextChange, mode),
    onFrameRemoved: (callback) => {
      if (typeof MutationObserver === "undefined") {
        return;
      }
      const observer = new MutationObserver(() => {
        const frame = state.getFrame();
        if (frame !== undefined && !frame.isConnected) {
          observer.disconnect();
          callback();
        }
      });
      observer.observe(document.documentElement, { childList: true, subtree: true });
    },
    onPageHide: (callback) => {
      window.addEventListener("pagehide", callback, { once: true });
    },
  };
  return { root, notifyContextChange };
}

/** Starts the browser entry point when the trusted static host page has loaded. */
export function startReferenceHostPage(): void {
  const element = document.getElementById("host");
  if (element === null) {
    return;
  }
  const { root, notifyContextChange } = createHostPagePort(element);
  window.addEventListener("resize", notifyContextChange);
  window.addEventListener("languagechange", notifyContextChange);
  window.addEventListener("fullscreenchange", notifyContextChange);
  if (typeof window.matchMedia === "function") {
    window
      .matchMedia("(prefers-color-scheme: dark)")
      .addEventListener("change", notifyContextChange);
  }
  if (typeof ResizeObserver !== "undefined") {
    const observer = new ResizeObserver(notifyContextChange);
    observer.observe(element);
  }
  void mountReferenceApp(root, window.location.hash).catch(() => {
    root.setStatus("host_unavailable");
  });
}

if (typeof document !== "undefined") {
  startReferenceHostPage();
}
