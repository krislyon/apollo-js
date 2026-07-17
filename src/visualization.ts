import type { StateMachineDefinition } from "./types.js";
import { normalizeTransitions, referenceName } from "./validation.js";

export function toMermaid(definition: StateMachineDefinition): string {
  const lines = ["stateDiagram-v2", `  [*] --> ${safeId(definition.initial)}`];
  for (const [source, state] of Object.entries(definition.states)) {
    if (state.description) lines.push(`  ${safeId(source)}: ${escapeLabel(state.description)}`);
    if (state.final) lines.push(`  ${safeId(source)} --> [*]`);
    for (const [event, value] of Object.entries(state.on ?? {})) {
      for (const transition of normalizeTransitions(value)) {
        const guards = transition.guards?.map(referenceName).join(" & ");
        const actions = transition.actions?.map(referenceName).join(", ");
        const details = [guards && `[${guards}]`, actions && `/ ${actions}`].filter(Boolean).join(" ");
        lines.push(`  ${safeId(source)} --> ${safeId(transition.target)}: ${escapeLabel(`${event}${details ? ` ${details}` : ""}`)}`);
      }
    }
  }
  return lines.join("\n");
}

export function toDot(definition: StateMachineDefinition): string {
  const lines = [`digraph "${escapeDot(definition.id)}" {`, "  rankdir=LR;", "  __start [shape=point];", `  __start -> "${escapeDot(definition.initial)}";`];
  for (const [source, state] of Object.entries(definition.states)) {
    lines.push(`  "${escapeDot(source)}" [shape=${state.final ? "doublecircle" : "circle"}];`);
    for (const [event, value] of Object.entries(state.on ?? {})) {
      for (const transition of normalizeTransitions(value)) {
        lines.push(`  "${escapeDot(source)}" -> "${escapeDot(transition.target)}" [label="${escapeDot(event)}"];`);
      }
    }
  }
  return [...lines, "}"].join("\n");
}

function safeId(value: string): string { return `s_${value.replace(/[^a-zA-Z0-9_]/g, "_")}`; }
function escapeLabel(value: string): string { return value.replace(/:/g, "&#58;").replace(/\n/g, " "); }
function escapeDot(value: string): string { return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"'); }
