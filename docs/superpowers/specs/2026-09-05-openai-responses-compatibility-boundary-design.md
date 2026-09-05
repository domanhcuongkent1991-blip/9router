# OpenAI Responses Compatibility Boundary Design

## Status

Approved direction: implement a practical `/v1/responses` compatibility layer
as an isolated boundary around the existing 9Router chat pipeline. This design
adds the requested risk assessment and mitigations before implementation.

## Goal

Make `POST /v1/responses` reliable for ordinary OpenAI SDK and Codex clients
without claiming support for OpenAI platform capabilities that 9Router cannot
provide locally.

The supported contract covers:

- streaming and non-streaming response creation;
- string and item-array input;
- developer/system instructions;
- URL and data-URI image input;
- function tools and the existing Codex custom-tool bridge;
- tool-call history and tool outputs;
- token limits, reasoning controls, tool choice, usage, and OpenAI-shaped
  errors.

## Non-goals

This change will not emulate OpenAI server-side application state or hosted
services. It will not implement:

- response retrieval, deletion, or cancellation;
- background responses;
- conversations or stored response state;
- `previous_response_id` lookup;
- OpenAI Files API resolution for `file_id` image inputs;
- hosted tools such as `web_search`, `file_search`, computer use, or remote MCP.

Requests for these features must receive an explicit OpenAI-shaped client error.
The adapter must not silently discard them or report a false success.

## Current State

`src/app/api/v1/responses/route.js` already forwards POST requests to
`handleChat`. Request and response translators convert between Responses and
Chat Completions formats, and the streaming pipeline already synthesizes a
terminal failure when a provider stream ends prematurely.

The existing implementation also has known edge cases:

- an invalid nameless function call can leave an empty `tool_calls` array;
- an OpenAI `file_id` can be treated as if it were an image URL;
- unsupported hosted or stateful features can be discarded or leak into a
  downstream provider instead of failing clearly;
- the main Responses response translator is already a large, frequently
  modified file, so broad edits there increase Git update risk.

The response-focused tests are present, but the separate test workspace does
not currently have its declared Vitest dependency installed. No existing test
result is treated as passing until the runner is restored and the tests execute.

## Alternatives Considered

### Patch the existing translators directly

This is the smallest immediate code diff, but it couples validation, protocol
policy, and provider conversion. It has the highest conflict risk when pulling
new GitHub changes and would make already-large translator files harder to
maintain. Rejected.

### Add an isolated compatibility boundary

Create small modules for validation, normalization, error construction, and
runtime composition. Keep the Next.js route as a thin wiring layer and leave
the core translators unchanged unless a failing contract test proves that a
narrow translator fix is required. Selected.

### Run a separate proxy service

This provides the strongest isolation from upstream 9Router changes, but it
adds another process, port, configuration surface, and failure mode. It is not
justified for the practical compatibility scope. Rejected for now.

## Architecture

The request path will be:

```text
Next.js route
    -> Responses runtime adapter
        -> parse and validate once
        -> normalize the supported subset
        -> build OpenAI-compatible client errors
        -> reconstruct a standard Fetch Request
    -> injected existing handleChat dispatcher
    -> existing provider and translation pipeline
```

The compatibility code will depend only on standard JavaScript and Fetch API
`Request`/`Response` types. It will not import Next.js runtime APIs. A small
factory will receive initialization and dispatch functions, allowing tests and
future runtimes to supply their own implementations.

Expected module responsibilities:

- `open-sse/compat/responses/request.js`: pure validation and normalization;
- `open-sse/compat/responses/error.js`: OpenAI-compatible error bodies;
- `open-sse/compat/responses/handler.js`: runtime-neutral handler composition;
- `src/app/api/v1/responses/route.js`: thin Next.js wiring only.

These filenames and responsibilities are fixed for the implementation. The
compatibility modules must not be folded into the existing translators.

## Request Contract

The boundary will parse the body exactly once and require a JSON object. It will
validate only fields needed to prevent ambiguity or data loss; provider-specific
model validation remains in the existing routing layer.

Supported request behavior:

- `input` may be a string or an array of Responses input items;
- `instructions` may be a string or supported message-item array;
- images require `image_url` containing an HTTP(S) URL or data URI;
- function and Codex custom tools require non-empty names;
- tool arguments and tool outputs are normalized to strings when the target
  Chat Completions format requires strings;
- overlong call identifiers use the existing deterministic 64-character clamp;
- `model`, `stream`, `store: false`, `include`, `tool_choice`,
  `parallel_tool_calls`, `max_output_tokens`, `temperature`, `top_p`,
  `reasoning`, `service_tier`, and `prompt_cache_key` are preserved when the
  existing provider pipeline supports them;
- `client_metadata` is accepted for current Codex clients and removed before a
  Chat Completions provider receives the request, matching current behavior.

Explicit rejection behavior:

- malformed JSON or a non-object body returns HTTP 400;
- `background: true`, `store: true`, `conversation`, or
  `previous_response_id` returns HTTP
  400 with the offending parameter named;
- `input_image.file_id` returns HTTP 400 because this app has no OpenAI Files
  API from which to resolve it;
- `input_file` returns HTTP 400 for the same reason;
- unsupported hosted tools return HTTP 400 with their tool type;
- malformed tool definitions and nameless tool-call history return HTTP 400.

Unknown request fields are left to the existing provider filter instead of
being rejected globally. This preserves forward compatibility with native
Responses providers. A field with known stateful or lossy semantics must be
added to one of the explicit supported, no-op, or rejected sets before this
boundary handles it specially.

Errors use the OpenAI envelope:

```json
{
  "error": {
    "message": "Human-readable explanation",
    "type": "invalid_request_error",
    "param": "field.path",
    "code": "unsupported_parameter"
  }
}
```

The boundary must never include authorization headers, API keys, request body
content, or provider credentials in the returned error.

## Response and Recovery Behavior

For non-streaming requests, the existing pipeline must return a complete
Responses object with a stable `id`, `object: "response"`, terminal status,
`output`, and normalized usage when the provider reports usage.

For streaming requests:

- event ordering and sequence numbers remain monotonic;
- only one terminal event is emitted;
- clean success terminates with `response.completed`;
- provider abort, truncated input, or a missing terminal event terminates with
  `response.failed` before the stream closes;
- the adapter does not retry model requests because retry and account fallback
  already belong to the provider layer;
- client cancellation is propagated through the existing request signal.

The compatibility boundary performs no persistent writes. A failed request can
therefore be retried by the client without adapter-owned partial state.

## Runtime Portability

Validation and normalization remain pure functions. Handler composition accepts
the existing dispatcher as a dependency and communicates using the standard
Fetch API. Moving from Next.js to Bun, Deno, a native Node server, or an Express
bridge should require a new wiring module rather than rewriting the protocol
logic.

Provider routing and translation remain 9Router-specific. Runtime portability
does not imply that the entire provider engine is framework-independent; it
means the new compatibility policy does not add another framework dependency.

## Git Update Strategy

Most implementation will be placed in new files. The existing route receives a
small import and composition change. High-churn translator and stream files are
modified only when a failing contract test cannot be satisfied at the boundary.

Before implementation:

1. preserve current unrelated workspace changes;
2. stage and commit only files belonging to this feature;
3. do not use broad staging commands;
4. restore the test runner from the already-declared test dependency only after
   verifying the registry source and generate a test-workspace lockfile if npm
   requires one. This is development tooling, not a runtime dependency.

For future GitHub updates, integrate upstream changes on a separate branch or
checkpoint, run the Responses contract suite and build, then promote the update.
This minimizes risk but cannot guarantee conflict-free updates if upstream edits
the same route or changes the internal `handleChat` contract.

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation | Verification |
| --- | --- | --- | --- | --- |
| Git conflict during an upstream update | Medium | Medium | Put most code in new files; keep route wiring small; commit feature files separately | Merge/fetch on a checkpoint branch and run `git diff --check` |
| Upstream changes `handleChat` semantics | Medium | High | Inject the dispatcher behind a runtime-neutral handler instead of importing it throughout compatibility code | Handler tests with a fake dispatcher plus integration test against the real function boundary |
| Silent loss of unsupported fields or tools | High without validation | High | Reject stateful and hosted features explicitly; name the parameter in the error | Negative contract tests for every unsupported feature |
| Provider-specific format loses images or tool metadata | Medium | High | Validate portable image forms; preserve tool identifiers; test a native Responses path and a Chat bridge path | Translator regression and representative provider tests |
| Stream closes without a terminal event | Medium | High | Preserve existing terminal-event guard; assert exactly one completed/failed terminal event | Truncated-stream, abort, and duplicate-terminal tests |
| Error handling leaks credentials or prompt data | Low | High | Use fixed error templates and field paths; never echo headers or full values | Tests using sentinel secrets and response-body assertions |
| Validation consumes excessive CPU on hostile input | Low | Medium | Use bounded, linear inspection of known arrays; rely on existing request-size limits; avoid recursive schema traversal | Large-but-bounded input test and code review |
| OpenAI evolves the Responses schema | High over time | Medium | Maintain an explicit supported-subset table and fixtures derived from current official documentation | Contract suite run after upstream or SDK upgrades |
| Tests pass only with live credentials | Medium without isolation | Medium | Keep boundary and handler tests offline with dependency injection; keep live provider tests optional | Default suite runs with no credentials or network |
| Test tooling is missing or substituted | Present | Medium | Verify the existing Vitest package through the configured npm registry and install only the declared locked dependency | Record package source/version, then run targeted suite |
| Runtime replacement exposes hidden Next.js coupling | Medium | Medium | Keep compatibility modules free of Next imports and use standard Fetch objects | Run handler tests directly under Node without loading a Next route |
| Current dirty working tree contaminates the feature | Present | High | Explicit-file staging and cached-diff review; never stage logs or unrelated tracked files | Inspect `git diff --cached --name-only` before each commit |

## Testing Strategy

Development follows test-driven development: add one failing behavioral test,
confirm that it fails for the intended reason, then make the smallest code
change that passes it.

The offline suite will cover:

1. valid string, item-array, function-tool, custom-tool, and URL/data-URI image
   requests;
2. malformed JSON and unsupported stateful, file-backed, and hosted-tool inputs;
3. no empty assistant `tool_calls` after validation and translation;
4. non-streaming output shape and usage;
5. streaming event order, monotonic sequence numbers, and exactly one terminal
   event;
6. provider error, client abort, and prematurely closed stream behavior;
7. sentinel secrets never appearing in an error response;
8. runtime-neutral handler execution with an injected fake dispatcher;
9. one native Responses-format path and one Chat Completions bridge path.

After targeted tests pass, run the existing Responses and translator regression
suites, `git diff --check`, and the production build. Live provider tests remain
optional because account state and quotas would make them non-deterministic.

## Success Criteria

The feature is complete only when:

- ordinary OpenAI SDK `responses.create()` requests in the supported subset work
  in stream and non-stream modes;
- unsupported capabilities fail before provider dispatch with OpenAI-shaped HTTP
  400 errors;
- all new tests are observed failing before their implementation and then pass;
- the existing Responses regression tests pass;
- the production build succeeds;
- compatibility modules do not import Next.js;
- no runtime dependency is added;
- the staged diff contains only feature files and no secrets or logs;
- limitations and the supported subset are documented for future maintainers.
