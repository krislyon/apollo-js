import assert from "node:assert/strict";
import test from "node:test";
import {
  ActionExecutionError, createMachine, InvalidDefinitionError, UnknownImplementationError, validateDefinition,
  type StateMachineDefinition,
} from "../index.js";

interface Context extends Record<string, unknown> {
  approved: boolean;
  audit: string[];
  requestId: string;
  tenant: { id: string; region: string };
}
type Event = { type: "APPROVE"; actor: string } | { type: "REVOKE"; actor: string };

const definition: StateMachineDefinition = {
  id: "access-request",
  initial: "pending",
  states: {
    pending: { on: { APPROVE: { target: "active", guards: [{ type: "isAllowed", params: { role: "admin" } }], actions: ["recordApproval"] } } },
    active: { entry: ["grantAccess"], on: { REVOKE: { target: "closed", actions: ["removeAccess"] } } },
    closed: { final: true },
  },
};

test("executes externally registered guards and actions", async () => {
  const machine = createMachine<Context, Event>(definition, {
    guards: { isAllowed: (_context, event, meta) => event.actor === "alice" && meta.params.role === "admin" },
    actions: {
      recordApproval: (context, event) => ({ audit: [...context.audit, `approved:${event.actor}`] }),
      grantAccess: () => ({ approved: true }),
      removeAccess: context => ({ approved: false, audit: [...context.audit, "revoked"] }),
    },
  }, {
    approved: false,
    audit: [],
    requestId: "req-123",
    tenant: { id: "tenant-a", region: "ca-central" },
  });

  const denied = await machine.send({ type: "APPROVE", actor: "bob" });
  assert.equal(denied.transitioned, false);
  const approved = await machine.send({ type: "APPROVE", actor: "alice" });
  assert.equal(approved.snapshot.state, "active");
  assert.deepEqual(approved.snapshot.context, {
    approved: true,
    audit: ["approved:alice"],
    requestId: "req-123",
    tenant: { id: "tenant-a", region: "ca-central" },
  });
  const revoked = await machine.send({ type: "REVOKE", actor: "alice" });
  assert.equal(revoked.snapshot.done, true);
  assert.deepEqual(revoked.snapshot.context, {
    approved: false,
    audit: ["approved:alice", "revoked"],
    requestId: "req-123",
    tenant: { id: "tenant-a", region: "ca-central" },
  });
});

test("does not transition or execute actions when a guard fails", async () => {
  let actionExecuted = false;
  const initialContext: Context = {
    approved: false,
    audit: [],
    requestId: "req-123",
    tenant: { id: "tenant-a", region: "ca-central" },
  };
  const machine = createMachine<Context, Event>(definition, {
    guards: { isAllowed: () => false },
    actions: {
      recordApproval: () => {
        actionExecuted = true;
        return { approved: true };
      },
      grantAccess: () => ({ approved: true }),
    },
  }, initialContext);

  const result = await machine.send({ type: "APPROVE", actor: "bob" });

  assert.equal(result.transitioned, false);
  assert.equal(result.snapshot.state, "pending");
  assert.deepEqual(result.snapshot.context, initialContext);
  assert.equal(actionExecuted, false);
});

test("runs all guards before exit, transition, and entry actions", async () => {
  const ordered: StateMachineDefinition = {
    id: "ordered",
    initial: "pending",
    states: {
      pending: { exit: ["exit"], on: { APPROVE: { target: "active", guards: ["guard"], actions: ["transition"] } } },
      active: { entry: ["entry"], final: true },
    },
  };
  const trace: string[] = [];
  const machine = createMachine<Context, Event>(ordered, {
    guards: { guard: () => { trace.push("guard"); return true; } },
    actions: {
      exit: () => { trace.push("exit"); },
      transition: () => { trace.push("transition"); },
      entry: () => { trace.push("entry"); },
    },
  }, {
    approved: false, audit: [], requestId: "req-123", tenant: { id: "tenant-a", region: "ca-central" },
  });

  await machine.send({ type: "APPROVE", actor: "alice" });
  assert.deepEqual(trace, ["guard", "exit", "transition", "entry"]);
});

test("does not transition for unknown or unavailable events", async () => {
  const initialContext: Context = {
    approved: false,
    audit: [],
    requestId: "req-123",
    tenant: { id: "tenant-a", region: "ca-central" },
  };
  const machine = createMachine<Context, Event>(definition, {}, initialContext);

  const unknown = await machine.send({ type: "UNKNOWN", actor: "alice" } as unknown as Event);
  assert.equal(unknown.transitioned, false);
  assert.equal(unknown.snapshot.state, "pending");
  assert.deepEqual(unknown.snapshot.context, initialContext);

  const unavailable = await machine.send({ type: "REVOKE", actor: "alice" });
  assert.equal(unavailable.transitioned, false);
  assert.equal(unavailable.snapshot.state, "pending");
  assert.deepEqual(unavailable.snapshot.context, initialContext);
});

test("reports missing implementations", async () => {
  const machine = createMachine<Context, Event>(definition, {}, {
    approved: false,
    audit: [],
    requestId: "req-123",
    tenant: { id: "tenant-a", region: "ca-central" },
  });
  await assert.rejects(machine.send({ type: "APPROVE", actor: "alice" }), UnknownImplementationError);
});

test("does not resolve events or implementations through the prototype chain", async () => {
  const machine = createMachine<Context, Event>(definition, {}, {
    approved: false,
    audit: [],
    requestId: "req-123",
    tenant: { id: "tenant-a", region: "ca-central" },
  });

  const inheritedEvent = await machine.send({ type: "constructor", actor: "alice" } as unknown as Event);
  assert.equal(inheritedEvent.transitioned, false);
  assert.equal(inheritedEvent.snapshot.state, "pending");

  const unsafeReference: StateMachineDefinition = {
    id: "unsafe-reference",
    initial: "pending",
    states: {
      pending: { on: { APPROVE: { target: "active", actions: ["constructor"] } } },
      active: { final: true },
    },
  };
  const unsafeMachine = createMachine<Context, Event>(unsafeReference, {}, inheritedEvent.snapshot.context as Context);
  await assert.rejects(unsafeMachine.send({ type: "APPROVE", actor: "alice" }), UnknownImplementationError);
  assert.equal(unsafeMachine.snapshot.state, "pending");
});

test("isolates machine data from callback and definition mutations", async () => {
  const machine = createMachine<Context, Event>(definition, {
    guards: {
      isAllowed: (context, _event, meta) => {
        context.audit.push("tampered");
        delete meta.definition.states.active;
        (meta.params as Record<string, unknown>).role = "tampered";
        return false;
      },
    },
  }, {
    approved: false,
    audit: [],
    requestId: "req-123",
    tenant: { id: "tenant-a", region: "ca-central" },
  });

  const exposedDefinition = machine.definition as StateMachineDefinition;
  delete exposedDefinition.states.active;
  const result = await machine.send({ type: "APPROVE", actor: "alice" });

  assert.deepEqual(result.snapshot.context.audit, []);
  assert.equal(result.snapshot.state, "pending");
  assert.ok(machine.definition.states.active);
});

test("rolls back internal state and context when a transition action fails", async () => {
  const transactional: StateMachineDefinition = {
    id: "transactional",
    initial: "pending",
    states: {
      pending: { on: { APPROVE: { target: "active", actions: ["update", "fail"] } } },
      active: { final: true },
    },
  };
  const machine = createMachine<Context, Event>(transactional, {
    actions: {
      update: () => ({ approved: true, audit: ["updated"] }),
      fail: () => { throw new Error("failure"); },
    },
  }, {
    approved: false,
    audit: [],
    requestId: "req-123",
    tenant: { id: "tenant-a", region: "ca-central" },
  });

  await assert.rejects(machine.send({ type: "APPROVE", actor: "alice" }), ActionExecutionError);
  assert.equal(machine.snapshot.state, "pending");
  assert.equal(machine.snapshot.context.approved, false);
  assert.deepEqual(machine.snapshot.context.audit, []);
});

test("rejects malformed runtime definitions with typed validation errors", () => {
  assert.throws(() => validateDefinition({ id: "bad", initial: "toString", states: {} }), InvalidDefinitionError);
  assert.throws(() => validateDefinition({
    id: "bad",
    initial: "pending",
    states: { pending: null },
  } as unknown as StateMachineDefinition), InvalidDefinitionError);
  assert.throws(() => validateDefinition({
    id: "bad",
    initial: "pending",
    states: { pending: { on: { GO: null } } },
  } as unknown as StateMachineDefinition), InvalidDefinitionError);
});

test("serializes concurrent events in call order", async () => {
  const concurrent: StateMachineDefinition = {
    id: "concurrent",
    initial: "pending",
    states: {
      pending: { on: { APPROVE: { target: "active", actions: ["delay"] } } },
      active: { on: { REVOKE: "closed" } },
      closed: { final: true },
    },
  };
  let finishDelay!: () => void;
  const delay = new Promise<void>(resolve => { finishDelay = resolve; });
  const machine = createMachine<Context, Event>(concurrent, {
    actions: { delay: async () => delay },
  }, {
    approved: false,
    audit: [],
    requestId: "req-123",
    tenant: { id: "tenant-a", region: "ca-central" },
  });

  const approving = machine.send({ type: "APPROVE", actor: "alice" });
  const revoking = machine.send({ type: "REVOKE", actor: "alice" });
  finishDelay();

  assert.equal((await approving).snapshot.state, "active");
  assert.equal((await revoking).snapshot.state, "closed");
  assert.equal(machine.snapshot.done, true);
});

test("prepares every transactional action before committing", async () => {
  const transactional: StateMachineDefinition = {
    id: "two-phase-success",
    initial: "pending",
    states: {
      pending: { on: { APPROVE: { target: "active", actions: ["record", "grant"] } } },
      active: { final: true },
    },
  };
  const trace: string[] = [];
  const machine = createMachine<Context, Event>(transactional, {
    transactionalActions: {
      record: context => {
        trace.push("prepare:record");
        return {
          update: { audit: [...context.audit, "recorded"] },
          commit: () => { trace.push("commit:record"); },
          rollback: () => { trace.push("rollback:record"); },
        };
      },
      grant: context => {
        trace.push(`prepare:grant:${context.audit.join(",")}`);
        return {
          update: { approved: true },
          commit: () => { trace.push("commit:grant"); },
          rollback: () => { trace.push("rollback:grant"); },
        };
      },
    },
  }, {
    approved: false, audit: [], requestId: "req-123", tenant: { id: "tenant-a", region: "ca-central" },
  }, { twoPhaseCommit: true });

  const result = await machine.send({ type: "APPROVE", actor: "alice" });
  assert.deepEqual(trace, ["prepare:record", "prepare:grant:recorded", "commit:record", "commit:grant"]);
  assert.equal(result.snapshot.context.approved, true);
  assert.deepEqual(result.snapshot.context.audit, ["recorded"]);
  assert.equal(result.snapshot.state, "active");
});

test("rolls back prepared actions and machine state when a transactional commit fails", async () => {
  const transactional: StateMachineDefinition = {
    id: "two-phase-failure",
    initial: "pending",
    states: {
      pending: { on: { APPROVE: { target: "active", actions: ["record", "grant"] } } },
      active: { final: true },
    },
  };
  const trace: string[] = [];
  let externalRecords = 0;
  const machine = createMachine<Context, Event>(transactional, {
    transactionalActions: {
      record: () => ({
        update: { audit: ["recorded"] },
        commit: () => { externalRecords++; trace.push("commit:record"); },
        rollback: () => { externalRecords--; trace.push("rollback:record"); },
      }),
      grant: () => ({
        update: { approved: true },
        commit: () => { trace.push("commit:grant"); throw new Error("grant failed"); },
        rollback: () => { trace.push("rollback:grant"); },
      }),
    },
  }, {
    approved: false, audit: [], requestId: "req-123", tenant: { id: "tenant-a", region: "ca-central" },
  }, { twoPhaseCommit: true });

  await assert.rejects(machine.send({ type: "APPROVE", actor: "alice" }), ActionExecutionError);
  assert.deepEqual(trace, ["commit:record", "commit:grant", "rollback:grant", "rollback:record"]);
  assert.equal(externalRecords, 0);
  assert.equal(machine.snapshot.state, "pending");
  assert.equal(machine.snapshot.context.approved, false);
  assert.deepEqual(machine.snapshot.context.audit, []);
});
