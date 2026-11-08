# Development

Read and apply [.pi/skills/right-sized-engineering/SKILL.md](.pi/skills/right-sized-engineering/SKILL.md).

This is a standalone AI web-builder library: Pi-backed bounded conversation and generation, reusable headless and React builder UI, project compilation, artifacts and sandboxed preview. The library must work without consumers reimplementing its model/agent loop or conversation UI. Keep core code, contracts, prompts and configuration domain-agnostic; consumers supply application instructions, public context and dependency approvals.

The first two example applications are interactive experiences/games and charts, explicitly authorised by the owner. Keep their domain prompts, data, approvals and presentation in `examples/`, outside the published core and its imports. Both must exercise the same builder APIs. Do not copy the platform application, its policy, configuration, private fixtures or Git history. Platform remains a separate private consumer.

Expose explicit Pi model access with key/local configuration and supported optional provider OAuth through application-owned credential stores and interaction hooks. Never discover or reuse harness credentials or silently switch providers. Do not build a separate cloud authentication product or give the model filesystem/shell execution tools.

Preserve bounded validation, compile-only server processing, exact trusted dependency resolution, artifact expiry, cancellation, bounded repair and sandbox lifecycle/message checks. Document public networking and browser resource limits accurately.

Use public package exports in consumer and distribution tests. Verify a packed installation outside this repository. Keep server code out of browser entry points. Do not invent a license grant or publish to npm.

Keep README concise: purpose, usage, development commands and essential limitations. No marketing, status narrative or process commentary.

Commit coherent changes. Before any public push, inspect all tracked files and reachable history for application code, private configuration and secrets. Never copy the platform Git history. The separate private platform migration worktree and old partial extraction directory are read-only references unless explicitly assigned for private migration work. No symlinks, submodules or imports pointing to them may enter this package.

Do not deploy, merge, make live model calls, borrow credentials, spend money, or modify retained services/data. Use isolated synthetic tests. No nested agents. Delegated work uses openai/gpt-6.1-sol without fallback.
