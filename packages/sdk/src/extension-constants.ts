// SPDX-License-Identifier: Apache-2.0
export const SDK_VERSION = "0.3.0";
export const VERSION_PATTERN = /^\d{1,5}\.\d{1,5}\.\d{1,5}$/u;
export const SDK_RANGE_TERM_PATTERN = /^([<>=]{1,2})?(\d{1,5}\.\d{1,5}\.\d{1,5})$/u;
export const MAX_EXTENSION_COUNT = 32;
export const MAX_CAPABILITIES = 16;
export const MAX_CAPABILITY_TARGETS = 64;
export const MAX_EXTENSION_TOOL_TIMEOUT_MS = 30_000;
export const DEFAULT_EXTENSION_TOOL_TIMEOUT_MS = 30_000;
export const MAX_EXTENSION_JSON_BYTES = 64 * 1024;
export const DEFAULT_EXTENSION_OUTPUT_BYTES = MAX_EXTENSION_JSON_BYTES;
export const MAX_EXTENSION_JSON_DEPTH = 32;
export const MAX_EXTENSION_JSON_NODES = 4_096;
