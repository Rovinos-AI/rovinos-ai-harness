# Basic agent

From the repository root, install the pinned dependencies, build the workspace, and run the example:

<!-- test:run -->

```bash
yarn install --immutable
yarn build
node --experimental-strip-types --disable-warning=ExperimentalWarning examples/basic-agent/run.ts
```

Expected output:

```text
run status: completed
inspected events: run_created, run_input, run_status_changed, model_request, model_response, tool_intent, tool_result, model_request, model_response, run_status_changed
```

The agent uses a Zod schema for its tool input, derives the model-visible JSON Schema from it, and
validates the arguments again before executing the tool. The scripted fake model and the in-memory
event store keep the example offline and synthetic.
