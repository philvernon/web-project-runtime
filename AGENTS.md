# Development

Read and apply [.pi/skills/right-sized-engineering/SKILL.md](.pi/skills/right-sized-engineering/SKILL.md).

This is a new, standalone generated-web-project runtime. Keep its code, tests, prompts, configuration and documentation domain-agnostic. Consumers supply model access, application instructions and dependency approvals. Do not add chart generation or a copy of the platform application.

Preserve bounded validation, compile-only server processing, exact trusted dependency resolution, artifact expiry, cancellation, bounded repair and sandbox lifecycle/message checks. Document public networking and browser resource limits accurately.

Use public package exports in consumer and distribution tests. Verify a packed installation outside this repository. Keep server code out of browser entry points. Do not invent a license grant or publish to npm.

Keep README concise: purpose, usage, development commands and essential limitations. No marketing, status narrative or process commentary.

Commit coherent changes. Before any public push, inspect all tracked files and reachable history for application code, private configuration and secrets. Never copy the platform Git history. The separate private platform migration worktree and old partial extraction directory are read-only references unless explicitly assigned for private migration work. No symlinks, submodules or imports pointing to them may enter this package.

Do not deploy, merge, make live model calls, borrow credentials, spend money, or modify retained services/data. Use isolated synthetic tests. No nested agents. Delegated work uses openai/gpt-6.1-sol without fallback.
