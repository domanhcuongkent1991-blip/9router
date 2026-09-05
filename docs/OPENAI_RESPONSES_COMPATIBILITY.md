# OpenAI Responses API Compatibility

9Router implements a stateless subset of `POST /v1/responses` for OpenAI SDK
and Codex clients.

## Endpoint

Use `http://localhost:20128/v1` as the OpenAI base URL and call
`responses.create()`.

## Supported

- Streaming and non-streaming response creation
- A non-empty `input` value, provided as a string or a supported item array
- `instructions` as a string
- HTTP(S) image URLs and image data URIs
- Function tools and Codex custom tools
- Function/custom tool-call history and outputs
- Token limits, reasoning controls, tool choice, prompt cache key, service
  tier, and usage fields when the selected provider supports them

## Explicitly unsupported

The adapter rejects these features before a provider request is sent:

- `background: true`
- `store: true`
- `conversation`
- `previous_response_id`
- Image `file_id` and `input_file`
- Hosted tools, including web search, file search, computer use, code
  interpreter, and remote MCP
- Response retrieval, deletion, and cancellation endpoints

Unsupported values receive an OpenAI-compatible HTTP 400 error. This endpoint
is stateless: it does not persist responses or retrieve earlier responses.

## Limitations

Provider support differs by model and provider. 9Router translates only the
portable subset above; it cannot add capabilities that the selected provider
does not implement.
