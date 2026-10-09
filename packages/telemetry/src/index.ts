// SPDX-License-Identifier: Apache-2.0
export { attr, getAttrMeta, isSafeAttr, type AttrMeta } from "./attr.js";
export { HarnessError, SpanRegistryError, type SpanRegistryIssue } from "./errors.js";
export {
  __resetRegistryForTests,
  defineSpan,
  listSpanDefinitions,
  lookupSpanDefinition,
  withSpan,
  type SpanDefinition,
  type SpanDefinitionShape,
  type SpanShape,
} from "./registry.js";
