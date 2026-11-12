# Authoring extensions

`@rovinos/extensions` is an optional authoring layer over the contracts in `@rovinos/sdk`. Install
it only in applications that define extensions:

```sh
npm install @rovinos/sdk @rovinos/extensions zod
```

For a bounded reference retrieval extension over an explicitly supplied corpus, install the
separate optional `@rovinos/extension-retrieval` package as well. It depends on both public packages
as peers and does not add a retrieval backend to the SDK.

An extension definition describes its identity, configuration schema, and contributions. The SDK
validates the definition and its registration; the helper does not add a separate contract or
runtime.

```ts
import { composeExtensions, defineExtension } from "@rovinos/extensions";
import { defineTool, type ExtensionRegistration } from "@rovinos/sdk";
import { z } from "zod";

const configSchema = z.object({ endpoint: z.url() });

const lookup = defineExtension({
  manifest: {
    id: "example.lookup",
    version: "1.0.0",
    sdkRange: ">=0.3.0 <0.4.0",
    schemaVersion: 1,
    capabilities: {
      required: [{ kind: "tools.contribute", names: ["lookup"] }],
      optional: [],
    },
  },
  configSchema,
  createContributions: (config) => ({
    tools: [
      defineTool({
        name: "lookup",
        description: "Return an empty result for a lookup request.",
        inputSchema: z.object({ query: z.string() }),
        outputSchema: z.object({ matches: z.array(z.string()) }),
        async execute(_input, { signal }) {
          signal.throwIfAborted();
          return { matches: [] };
        },
      }),
    ],
  }),
});

const registration = {
  namespace: "catalog",
  definition: lookup,
  config: { endpoint: "https://catalog.example" },
  grants: [{ kind: "tools.contribute", names: ["lookup"] }],
} satisfies ExtensionRegistration<typeof lookup>;

const extensions = composeExtensions([registration]);
```

Pass the registrations to `createHarness({ extensions })`. The grant above is supplied by the
application operator; a manifest request or call to `defineExtension` does not grant access.
Provide only the configuration and destinations the application intends to authorize.

Extensions are trusted application code, not sandboxed plugins. Importing an implementation can
execute its module initialization before SDK validation, and in-process validation governs only
SDK-mediated contribution paths. It does not prevent filesystem, network, or process access. Run
untrusted extensions behind an independently enforced process or container boundary with explicit
communication and egress policy.

Test-only registration helpers are available from the opt-in `@rovinos/extensions/testing`
subpath. Import that subpath only in test code; the default `@rovinos/extensions` entry does not
export or load the testing helpers.
