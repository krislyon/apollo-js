import assert from "node:assert/strict";
import test from "node:test";
import { createMachine, UnknownImplementationError, type StateMachineDefinition } from "../index.js";

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

test("reports missing implementations", async () => {
  const machine = createMachine<Context, Event>(definition, {}, {
    approved: false,
    audit: [],
    requestId: "req-123",
    tenant: { id: "tenant-a", region: "ca-central" },
  });
  await assert.rejects(machine.send({ type: "APPROVE", actor: "alice" }), UnknownImplementationError);
});
