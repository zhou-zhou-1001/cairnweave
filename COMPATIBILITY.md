# CairnWeave compatibility and migration

CairnWeave is the new public identity of the project previously named **Agent Integrity Guard**, whose package name was `agent-integrity-guard`.

## Migration status

- New installations and examples use `cairnweave`.
- The root CommonJS API is unchanged. Existing names such as `relayExternalResult`, `ResultStore`, `MemoryPassport`, `captureAgentTask`, and `captureCodexTask` remain available.
- Existing CLI filenames under `bin/guard-*.js` remain in place to avoid breaking scripts.
- Existing serialized identifiers—including `agent-integrity-guard/agent-task`, `agent-integrity-guard/codex-task`, and `agent-integrity-guard/artifact-envelope`—remain unchanged. They are wire/storage compatibility identifiers, not current branding.
- The legacy enumerable root export list remains unchanged. Protocol APIs and the injected-stream NDJSON adapter are exposed through the additive `cairnweave/protocol` subpath and a non-enumerable `protocol` root namespace.
- `captureCodexTask()` and the Codex CLI remain compatibility adapters.

Consumers installed under the old package name can continue to call the same API from that installed version:

```js
const { relayExternalResult } = require('agent-integrity-guard');
```

When moving to the renamed package, change only the dependency and module specifier unless adopting another API intentionally:

```js
const { relayExternalResult } = require('cairnweave');
```

No artifact rewrite is required or recommended. CairnWeave continues to read the existing schemas so stored task and envelope data remain valid.
