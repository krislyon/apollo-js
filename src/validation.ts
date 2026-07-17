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
  if (!isRecord(definition)) throw new InvalidDefinitionError("Machine definition must be an object");
  if (typeof definition.id !== "string" || !definition.id.trim()) throw new InvalidDefinitionError("Machine definition requires a non-empty id");
  if (typeof definition.initial !== "string" || !definition.initial.trim()) throw new InvalidDefinitionError("Machine definition requires a non-empty initial state");
  if (!isRecord(definition.states) || Object.keys(definition.states).length === 0) {
    throw new InvalidDefinitionError("Machine definition requires at least one state");
  }
  if (!Object.hasOwn(definition.states, definition.initial)) {
    throw new InvalidDefinitionError(`Initial state '${definition.initial}' does not exist`);
  }

  for (const [stateName, state] of Object.entries(definition.states)) {
    if (!isRecord(state)) throw new InvalidDefinitionError(`State '${stateName}' must be an object`);
    if (state.final && state.on && Object.keys(state.on).length > 0) {
      throw new InvalidDefinitionError(`Final state '${stateName}' cannot define transitions`);
    }
    if (state.on !== undefined && !isRecord(state.on)) throw new InvalidDefinitionError(`Transitions for state '${stateName}' must be an object`);
    for (const [event, value] of Object.entries(state.on ?? {})) {
      if (!event) throw new InvalidDefinitionError(`State '${stateName}' has a transition with an empty event type`);
      const transitions = validateTransitionValue(value, `${stateName}.${event}`);
      if (transitions.length === 0) throw new InvalidDefinitionError(`Transition '${stateName}.${event}' has no candidates`);
      for (const transition of transitions) {
        if (!Object.hasOwn(definition.states, transition.target)) {
          throw new InvalidDefinitionError(`Transition '${stateName}.${event}' targets unknown state '${transition.target}'`);
        }
        validateReferences(transition.guards, `${stateName}.${event}.guards`);
        validateReferences(transition.actions, `${stateName}.${event}.actions`);
      }
    }
    validateReferences(state.entry as Reference[] | undefined, `${stateName}.entry`);
    validateReferences(state.exit as Reference[] | undefined, `${stateName}.exit`);
  }
}

function validateReferences(references: Reference[] | undefined, path: string): void {
  if (references !== undefined && !Array.isArray(references)) throw new InvalidDefinitionError(`References at '${path}' must be an array`);
  for (const reference of references ?? []) {
    if (typeof reference !== "string" && !isRecord(reference)) throw new InvalidDefinitionError(`Reference at '${path}' must be a string or object`);
    const name = referenceName(reference);
    if (typeof name !== "string" || !name.trim()) throw new InvalidDefinitionError(`Reference at '${path}' requires a non-empty type`);
    if (typeof reference !== "string" && reference.params !== undefined && !isRecord(reference.params)) {
      throw new InvalidDefinitionError(`Reference params at '${path}' must be an object`);
    }
  }
}

function validateTransitionValue(value: unknown, path: string): TransitionDefinition[] {
  if (typeof value === "string") {
    if (!value.trim()) throw new InvalidDefinitionError(`Transition '${path}' requires a non-empty target`);
    return [{ target: value }];
  }
  const values = Array.isArray(value) ? value : [value];
  if (values.length === 0) throw new InvalidDefinitionError(`Transition '${path}' has no candidates`);
  for (const transition of values) {
    if (!isRecord(transition) || typeof transition.target !== "string" || !transition.target.trim()) {
      throw new InvalidDefinitionError(`Transition '${path}' requires a non-empty target`);
    }
    validateReferences(transition.guards as Reference[] | undefined, `${path}.guards`);
    validateReferences(transition.actions as Reference[] | undefined, `${path}.actions`);
  }
  return values as unknown as TransitionDefinition[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
