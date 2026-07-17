import assert from "node:assert/strict";
import test from "node:test";
import { analyzeModel, analyzeResourceClosure } from "../analysis/index.js";
import type { StateMachineDefinition } from "../index.js";
import { toMermaid } from "../visualization.js";

const model: StateMachineDefinition = {
  id: "door",
  initial: "locked",
  states: {
    locked: { on: { OPEN: { target: "open", actions: ["provideAccess"] } } },
    open: { on: { CLOSE: { target: "done", actions: ["removeAccess"] } } },
    done: { final: true },
    orphan: {},
  },
};

test("renders Mermaid source", () => {
  const output = toMermaid(model);
  assert.match(output, /stateDiagram-v2/);
  assert.match(output, /OPEN \/ provideAccess/);
});

test("finds structural issues", () => {
  assert.deepEqual(analyzeModel(model).map(issue => issue.kind).sort(), ["dead-end", "unreachable"]);
});

test("proves resource closure across reachable configurations", () => {
  const result = analyzeResourceClosure(model, { effects: { provideAccess: { acquire: ["door-access"] }, removeAccess: { release: ["door-access"] } } });
  assert.equal(result.valid, true);
});

test("reports a path that leaks access", () => {
  const unsafe: StateMachineDefinition = structuredClone(model);
  unsafe.states.open!.on!.CLOSE = "done";
  const result = analyzeResourceClosure(unsafe, { effects: { provideAccess: { acquire: ["door-access"] } } });
  assert.equal(result.valid, false);
  assert.equal(result.issues[0]?.kind, "leak");
  assert.deepEqual(result.issues[0]?.path, ["locked", "OPEN -> open", "CLOSE -> done"]);
});
