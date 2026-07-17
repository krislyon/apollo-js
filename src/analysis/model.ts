import type { StateMachineDefinition } from "../types.js";
import { normalizeTransitions } from "../validation.js";

export interface ModelIssue { kind: "unreachable" | "dead-end"; state: string; message: string }

export function analyzeModel(definition: StateMachineDefinition): ModelIssue[] {
  const reachable = new Set<string>();
  const queue = [definition.initial];
  while (queue.length) {
    const state = queue.shift()!;
    if (reachable.has(state)) continue;
    reachable.add(state);
    for (const value of Object.values(definition.states[state]?.on ?? {})) {
      for (const transition of normalizeTransitions(value)) queue.push(transition.target);
    }
  }
  const issues: ModelIssue[] = [];
  for (const [name, state] of Object.entries(definition.states)) {
    if (!reachable.has(name)) issues.push({ kind: "unreachable", state: name, message: `State '${name}' is unreachable` });
    if (!state.final && Object.keys(state.on ?? {}).length === 0) issues.push({ kind: "dead-end", state: name, message: `Non-final state '${name}' has no outgoing transitions` });
  }
  return issues;
}
