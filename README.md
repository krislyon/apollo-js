# JSON State Machine

A small TypeScript state machine whose topology and behavior references live in JSON. The runtime owns transition semantics; the consuming application supplies guard and action implementations. No application behavior needs to be compiled into this library.

## Install and build

```sh
npm install
npm run build
npm test
```

The package has no runtime dependencies and targets Node.js 18 or later.

## Define a model in JSON

```json
{
  "id": "access-control",
  "initial": "requested",
  "states": {
    "requested": {
      "on": {
        "APPROVE": {
          "target": "active",
          "guards": [{ "type": "hasRole", "params": { "role": "administrator" } }],
          "actions": ["recordApproval", "provideAccess"]
        }
      }
    },
    "active": {
      "on": { "REVOKE": { "target": "closed", "actions": ["removeAccess"] } }
    },
    "closed": { "final": true }
  }
}
```

The bundled `schema/state-machine.schema.json` enables editor validation. A transition may be a target string, a transition object, or an ordered array of guarded candidates. The first candidate whose guards all pass is selected.

## Supply behavior from the application

```ts
import definition from "./access-control.json" with { type: "json" };
import { createMachine, type StateMachineDefinition } from "json-state-machine";

type Context = { access: boolean; audit: string[] };
type Event = { type: "APPROVE" | "REVOKE"; actor: string };

const machine = createMachine<Context, Event>(definition as StateMachineDefinition, {
  guards: {
    hasRole: (_context, event, meta) =>
      event.actor === "alice" && meta.params.role === "administrator"
  },
  actions: {
    recordApproval: (context, event) => ({ audit: [...context.audit, event.actor] }),
    provideAccess: () => ({ access: true }),
    removeAccess: () => ({ access: false })
  }
}, { access: false, audit: [] });

await machine.start();
const result = await machine.send({ type: "APPROVE", actor: "alice" });
console.log(result.snapshot.state); // active
```

Actions and guards may be synchronous or asynchronous. Actions return a partial context update; updates are merged in execution order. Execution order is source `exit`, transition actions, then target `entry`. Missing implementations throw by default, or can be tolerated with `{ strictImplementations: false }`.

## User-defined context

Context is application-owned data carried alongside the machine state. It can contain any structured information your application needs, such as request identifiers, users, tenants, accumulated results, or domain data. The machine passes the current context to every guard and action:

```ts
type Context = {
  requestId: string;
  tenant: { id: string; region: string };
  accessGranted: boolean;
};

const machine = createMachine<Context, Event>(definition, {
  guards: {
    isCanadianTenant: context => context.tenant.region === "ca-central"
  },
  actions: {
    grantAccess: context => ({
      accessGranted: true
      // requestId and tenant are preserved by the partial update
    })
  }
}, {
  requestId: "req-123",
  tenant: { id: "tenant-a", region: "ca-central" },
  accessGranted: false
});
```

Guards and actions receive a read-only view of context to prevent accidental in-place mutation. An action may return a partial update or a complete context object. The runtime merges that result into the existing context, preserving unrelated application fields. The current value is available as `machine.snapshot.context` and is included in every transition result.

## Visualization

The optional `json-state-machine/visualization` entry point produces portable text formats:

```ts
import { toMermaid, toDot } from "json-state-machine/visualization";
console.log(toMermaid(definition));
```

Mermaid renders directly in many Markdown tools. DOT can be rendered by Graphviz.

## Analysis and access closure

Map action names to their abstract effects, then explore every reachable `(state, acquired-resources)` configuration:

```ts
import { analyzeModel, analyzeResourceClosure } from "json-state-machine/analysis";

const structureIssues = analyzeModel(definition);
const closure = analyzeResourceClosure(definition, {
  effects: {
    provideAccess: { acquire: ["system-access"] },
    removeAccess: { release: ["system-access"] }
  }
});

if (!closure.valid) console.error(closure.issues);
```

The analyzer reports terminal paths that retain a resource, releases without a matching acquisition, and analyses that exceed the configured state-space limit. Guards are conservatively treated as potentially true, so every declared branch is checked. Resource ownership is set-based: acquiring an already-held resource is idempotent. This makes the result useful for access, locks, subscriptions, temporary credentials, and similar provide/remove pairs.

`analyzeModel` additionally reports unreachable states and non-final dead ends.

## Scope

This first version implements flat finite state machines, ordered guarded transitions, entry/exit/transition actions, immutable snapshots, Mermaid/DOT output, and finite resource-closure analysis. Hierarchical and parallel states, persistence adapters, delayed events, and invoked services are intentionally left for later extensions.
