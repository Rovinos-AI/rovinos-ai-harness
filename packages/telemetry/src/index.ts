// SPDX-License-Identifier: Apache-2.0
export { attr, getAttrMeta, isSafeAttr, type AttrMeta } from "./attr.js";
export { SpanRegistryError, type SpanRegistryIssue } from "./errors.js";
export {
  __resetRegistryForTests,
  defineSpan,
  ensureTracingFallback,
  listSpanDefinitions,
  lookupSpanDefinition,
  withSpan,
  type SpanDefinition,
  type SpanDefinitionShape,
  type SpanShape,
} from "./registry.js";
