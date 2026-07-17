import { ActionExecutionError, UnknownImplementationError } from "./errors.js";
import type {
  ActionResult, ExecutionMeta, Implementations, MachineOptions, Reference, StateMachineDefinition,
  StateSnapshot, TransitionDefinition, TransitionResult
} from "./types.js";
import { normalizeTransitions, referenceName, referenceParams, validateDefinition } from "./validation.js";

export class StateMachine<Context extends Record<string, unknown>, Event extends { type: string }> {
  readonly #definition: StateMachineDefinition;
  readonly #implementations: Implementations<Context, Event>;
  readonly #strict: boolean;
  #state: string;
  #context: Context;
  #started = false;

  public constructor(
    definition: StateMachineDefinition,
    implementations: Implementations<Context, Event> = {},
    initialContext?: Context,
    options: MachineOptions = {},
  ) {
    validateDefinition(definition);
    this.#definition = structuredClone(definition);
    this.#implementations = implementations;
    this.#strict = options.strictImplementations ?? true;
    this.#state = definition.initial;
    this.#context = structuredClone((initialContext ?? definition.context ?? {}) as Context);
  }

  public get definition(): Readonly<StateMachineDefinition> { return this.#definition; }
  public get snapshot(): StateSnapshot<Context> {
    return Object.freeze({
      machineId: this.#definition.id,
      state: this.#state,
      context: structuredClone(this.#context),
      done: this.#definition.states[this.#state]?.final === true,
    });
  }

  public async start(event = { type: "@@start" } as Event): Promise<StateSnapshot<Context>> {
    if (!this.#started) {
      this.#started = true;
      await this.#runActions(this.#definition.states[this.#state]?.entry ?? [], event, this.#state, this.#state);
    }
    return this.snapshot;
  }

  public async send(event: Event): Promise<TransitionResult<Context>> {
    if (!this.#started) await this.start();
    const stateDefinition = this.#definition.states[this.#state];
    const candidates = stateDefinition?.on?.[event.type];
    if (!candidates) return { transitioned: false, snapshot: this.snapshot };

    const source = this.#state;
    let selected: TransitionDefinition | undefined;
    for (const candidate of normalizeTransitions(candidates)) {
      if (await this.#passes(candidate.guards ?? [], event, source, candidate.target)) {
        selected = candidate;
        break;
      }
    }
    if (!selected) return { transitioned: false, snapshot: this.snapshot };

    await this.#runActions(stateDefinition.exit ?? [], event, source, selected.target);
    await this.#runActions(selected.actions ?? [], event, source, selected.target);
    this.#state = selected.target;
    await this.#runActions(this.#definition.states[this.#state]?.entry ?? [], event, source, selected.target);
    return { transitioned: true, snapshot: this.snapshot };
  }

  async #passes(references: Reference[], event: Event, source: string, target: string): Promise<boolean> {
    for (const reference of references) {
      const name = referenceName(reference);
      const guard = this.#implementations.guards?.[name];
      if (!guard) {
        if (this.#strict) throw new UnknownImplementationError(`Guard '${name}' is not registered`);
        return false;
      }
      if (!(await guard(this.#context, event, this.#meta(reference, event, source, target)))) return false;
    }
    return true;
  }

  async #runActions(references: Reference[], event: Event, source: string, target: string): Promise<void> {
    for (const reference of references) {
      const name = referenceName(reference);
      const action = this.#implementations.actions?.[name];
      if (!action) {
        if (this.#strict) throw new UnknownImplementationError(`Action '${name}' is not registered`);
        continue;
      }
      try {
        const result = await action(this.#context, event, this.#meta(reference, event, source, target));
        this.#context = applyResult(this.#context, result);
      } catch (cause) {
        throw new ActionExecutionError(`Action '${name}' failed while transitioning '${source}' -> '${target}'`, cause);
      }
    }
  }

  #meta(reference: Reference, event: Event, source: string, target: string): ExecutionMeta<Context, Event> {
    return { definition: this.#definition, source, target, event, snapshot: this.snapshot, params: referenceParams(reference) };
  }
}

function applyResult<Context extends Record<string, unknown>>(context: Context, result: ActionResult<Context>): Context {
  if (result === undefined) return context;
  return { ...context, ...result };
}

export function createMachine<Context extends Record<string, unknown>, Event extends { type: string }>(
  definition: StateMachineDefinition,
  implementations: Implementations<Context, Event> = {},
  initialContext?: Context,
  options?: MachineOptions,
): StateMachine<Context, Event> {
  return new StateMachine(definition, implementations, initialContext, options);
}
