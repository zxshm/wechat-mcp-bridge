# Recovery change validation

This change ports the verified recovery code onto the public repository's existing configuration interface. It does not include a deployment snapshot, account configuration, message history, runtime state, credentials, or media.

## Scope and provenance

The source review compared 20 runtime modules with SHA-256 metadata from the running installation. The public port retains the existing configurable issuer, audience, owner, host and state directory. Consequently `server-v2.mjs`, `bridge-model-live.mjs` and `safe-diagnostics.mjs` intentionally differ from their deployment-specific sources. Other source differences introduced by Git line-ending normalization do not represent a production deployment. The two tunnel logger modules retain their exact byte hashes in [runtime-sha256.json](../tunnel-safe-log/runtime-sha256.json).

The shared send budget, ninth-slot media reminder, queued-only cancellation, explicit unknown-delivery cancellation and startup pause/resume guard are included together. The capacity change admits at most 1024 retained events with a 7 MiB admission threshold and an 8 MiB plaintext storage limit. Existing retention, owner scope, deduplication and unknown-delivery evidence remain enforced.

## Validation

The complete public source/test bundle passed **305 tests, zero failures and zero skips** on Linux with Node.js 25.4.0. This includes real Linux file permissions, encrypted-storage bounds, atomic inbound batches/cursors, mixed media budgets, cancellation persistence, resume guards, JWT validation, request diagnostics, logger cleanup, process signals and offline systemd template verification.

The run used a separate temporary directory, a network namespace with no routes, poisoned default network entry points, synthetic state and a hidden real home directory. Existing dependencies were mounted read-only. Tests did not start services, use a production token or poll/send real messages. Temporary test directories were removed after verification.

Run the full suite from `wechat-core-offline` with `npm ci --ignore-scripts` followed by `npm test`. Dependency installation needs network access; test traffic is mocked and default network calls throw. The repository CI also exercises the supported Node.js 24 line.

## Limits that remain explicit

- Budget accounting follows retained records; after 24-hour expiry the same token can obtain a new allowance. This is not a strict lifetime quota across retention windows.
- Media waiting for a fresh context stays in its original in-memory cache for at most 15 minutes and is not recovered after restart. Unknown attempts are never automatically retried.
- Startup pauses automatic synchronization. An authorized, explicit resume requires a current epoch and a verifiable resolved queue; ordinary inbound polling and direct replies remain separate.
- Optional MCP diagnostic files use capacity rotation, not guaranteed 24-hour deletion. The separate tunnel logger has bounded physical cleanup as described in [tunnel diagnostics](tunnel-diagnostics.md).
- The HTTP/2 template is an optional reversible transport trial. A successful observation window does not prove a permanent cure for tunnel disconnects.
