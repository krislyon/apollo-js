import { InvalidDefinitionError } from "./errors.js";
import type { Reference, StateMachineDefinition, TransitionDefinition, TransitionValue } from "./types.js";

export function referenceName(reference: Reference): string {
  return typeof reference === "string" ? reference : reference.type;
}

export function referenceParams(reference: Reference): Record<string, never> | NonNullable<Exclude<Reference, string>["params"]> {
  return typeof reference === "string" ? {} : (reference.params ?? {});
}

export function normalizeTransitions(value: TransitionValue): TransitionDefinition[] {
  if (typeof value === "string") return [{ target: value }];
  return Array.isArray(value) ? value : [value];
}

export function validateDefinition(definition: StateMachineDefinition): void {
  if (!definition || typeof definition !== "object") throw new InvalidDefinitionError("Machine definition must be an object");
  if (!definition.id) throw new InvalidDefinitionError("Machine definition requires a non-empty id");
  if (!definition.states || typeof definition.states !== "object" || Object.keys(definition.states).length === 0) {
    throw new InvalidDefinitionError("Machine definition requires at least one state");
  }
  if (!definition.states[definition.initial]) {
    throw new InvalidDefinitionError(`Initial state '${definition.initial}' does not exist`);
  }

  for (const [stateName, state] of Object.entries(definition.states)) {
    if (state.final && state.on && Object.keys(state.on).length > 0) {
      throw new InvalidDefinitionError(`Final state '${stateName}' cannot define transitions`);
    }
    for (const [event, value] of Object.entries(state.on ?? {})) {
      const transitions = normalizeTransitions(value);
      if (transitions.length === 0) throw new InvalidDefinitionError(`Transition '${stateName}.${event}' has no candidates`);
      for (const transition of transitions) {
        if (!definition.states[transition.target]) {
          throw new InvalidDefinitionError(`Transition '${stateName}.${event}' targets unknown state '${transition.target}'`);
        }
        validateReferences(transition.guards, `${stateName}.${event}.guards`);
        validateReferences(transition.actions, `${stateName}.${event}.actions`);
      }
    }
    validateReferences(state.entry, `${stateName}.entry`);
    validateReferences(state.exit, `${stateName}.exit`);
  }
}

function validateReferences(references: Reference[] | undefined, path: string): void {
  for (const reference of references ?? []) {
    const name = referenceName(reference);
    if (!name) throw new InvalidDefinitionError(`Reference at '${path}' requires a non-empty type`);
  }
}
