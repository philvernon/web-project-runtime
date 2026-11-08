# Web project runtime

Generate JavaScript web projects with an LLM, validate and compile them, and render them in a sandboxed browser frame.

The caller supplies the model, instructions and approved dependencies. The runtime handles project validation, bundling, artifacts and the browser lifecycle. It has no application-domain dependencies.

## Development

Node.js 24 and npm 11.

Package usage and development commands will be added with the implementation.

## Isolation

Generated code runs in an opaque iframe, not on the server. The host must configure the required content security policy. Public networking is allowed; browser isolation does not provide hard CPU or memory limits.
