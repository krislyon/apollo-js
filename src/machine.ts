import { ActionExecutionError, UnknownImplementationError } from "./errors.js";
import type {
  ActionResult, ExecutionMeta, Implementations, MachineOptions, PreparedAction, Reference, StateMachineDefinition,
  StateSnapshot, TransitionDefinition, TransitionResult
} from "./types.js";
import { normalizeTransitions, referenceName, referenceParams, validateDefinition } from "./validation.js";

export class StateMachine<Context extends Record<string, unknown>, Event extends { type: string }> {
  readonly #definition: StateMachineDefinition;
  readonly #implementations: Implementations<Context, Event>;
  readonly #strict: boolean;
  readonly #twoPhaseCommit: boolean;
  #state: string;
  #context: Context;
  #started = false;
  #startPromise: Promise<void> | undefined;
  #sendQueue: Promise<void> = Promise.resolve();

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
    this.#twoPhaseCommit = options.twoPhaseCommit ?? false;
    this.#state = definition.initial;
    this.#context = structuredClone((initialContext ?? definition.context ?? {}) as Context);
  }

  public get definition(): Readonly<StateMachineDefinition> { return structuredClone(this.#definition); }
  public get snapshot(): StateSnapshot<Context> {
    return Object.freeze({
      machineId: this.#definition.id,
      state: this.#state,
      context: structuredClone(this.#context),
      done: this.#definition.states[this.#state]?.final === true,
    });
  }

  public async start(event = { type: "@@start" } as Event): Promise<StateSnapshot<Context>> {
    if (!this.#started && !this.#startPromise) {
      this.#startPromise = (async () => {
        const context = await this.#executeActions(this.#context, [{
          references: this.#definition.states[this.#state]?.entry ?? [], source: this.#state, target: this.#state,
        }], event);
        this.#context = context;
        this.#started = true;
      })();
    }
    try {
      await this.#startPromise;
    } catch (error) {
      this.#startPromise = undefined;
      throw error;
    }
    return this.snapshot;
  }

  public async send(event: Event): Promise<TransitionResult<Context>> {
    const previous = this.#sendQueue;
    let release!: () => void;
    this.#sendQueue = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try {
      return await this.#send(event);
    } finally {
      release();
    }
  }

  async #send(event: Event): Promise<TransitionResult<Context>> {
    if (!this.#started) await this.start();
    const stateDefinition = this.#definition.states[this.#state];
    if (!stateDefinition) return { transitioned: false, snapshot: this.snapshot };
    const candidates = stateDefinition?.on && Object.hasOwn(stateDefinition.on, event.type) ? stateDefinition.on[event.type] : undefined;
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

    const context = await this.#executeActions(this.#context, [
      { references: stateDefinition.exit ?? [], source, target: selected.target },
      { references: selected.actions ?? [], source, target: selected.target },
      { references: this.#definition.states[selected.target]?.entry ?? [], source, target: selected.target },
    ], event);
    this.#context = context;
    this.#state = selected.target;
    return { transitioned: true, snapshot: this.snapshot };
  }

  async #passes(references: Reference[], event: Event, source: string, target: string): Promise<boolean> {
    for (const reference of references) {
      const name = referenceName(reference);
      const guards = this.#implementations.guards;
      const guard = guards && Object.hasOwn(guards, name) ? guards[name] : undefined;
      if (!guard) {
        if (this.#strict) throw new UnknownImplementationError(`Guard '${name}' is not registered`);
        return false;
      }
      if (!(await guard(structuredClone(this.#context), event, this.#meta(reference, event, source, target)))) return false;
    }
    return true;
  }

  async #runActions(context: Context, references: Reference[], event: Event, source: string, target: string): Promise<Context> {
    for (const reference of references) {
      const name = referenceName(reference);
      const actions = this.#implementations.actions;
      const action = actions && Object.hasOwn(actions, name) ? actions[name] : undefined;
      if (!action) {
        if (this.#strict) throw new UnknownImplementationError(`Action '${name}' is not registered`);
        continue;
      }
      try {
        const result = await action(structuredClone(context), event, this.#meta(reference, event, source, target, context));
        context = applyResult(context, result === undefined ? undefined : structuredClone(result) as ActionResult<Context>);
      } catch (cause) {
        throw new ActionExecutionError(`Action '${name}' failed while transitioning '${source}' -> '${target}'`, cause);
      }
    }
    return context;
  }

  async #executeActions(context: Context, steps: ActionStep[], event: Event): Promise<Context> {
    if (this.#twoPhaseCommit) return this.#runTransactionalActions(context, steps, event);
    for (const step of steps) context = await this.#runActions(context, step.references, event, step.source, step.target);
    return context;
  }

  async #runTransactionalActions(context: Context, steps: ActionStep[], event: Event): Promise<Context> {
    const prepared: Array<{ name: string; operation: PreparedAction<Context> }> = [];
    let activeName = "unknown";
    try {
      for (const step of steps) {
        for (const reference of step.references) {
          activeName = referenceName(reference);
          const actions = this.#implementations.transactionalActions;
          const action = actions && Object.hasOwn(actions, activeName) ? actions[activeName] : undefined;
          if (!action) {
            if (this.#strict) throw new UnknownImplementationError(`Transactional action '${activeName}' is not registered`);
            continue;
          }
          const operation = await action(
            structuredClone(context), event, this.#meta(reference, event, step.source, step.target, context),
          );
          prepared.push({ name: activeName, operation });
          context = applyResult(
            context,
            operation.update === undefined ? undefined : structuredClone(operation.update) as ActionResult<Context>,
          );
        }
      }
      for (const item of prepared) {
        activeName = item.name;
        await item.operation.commit?.();
      }
      return context;
    } catch (cause) {
      const rollbackErrors: unknown[] = [];
      for (const item of [...prepared].reverse()) {
        try { await item.operation.rollback?.(); } catch (error) { rollbackErrors.push(error); }
      }
      const combinedCause = rollbackErrors.length === 0 ? cause : new AggregateError([cause, ...rollbackErrors], "Action and rollback failures");
      if (cause instanceof UnknownImplementationError) throw cause;
      throw new ActionExecutionError(`Transactional action '${activeName}' failed while preparing or committing`, combinedCause);
    }
  }

  #meta(reference: Reference, event: Event, source: string, target: string, context = this.#context): ExecutionMeta<Context, Event> {
    return {
      definition: structuredClone(this.#definition), source, target, event,
      snapshot: Object.freeze({ ...this.snapshot, context: structuredClone(context) }),
      params: structuredClone(referenceParams(reference)),
    };
  }
}

interface ActionStep { references: Reference[]; source: string; target: string }

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
