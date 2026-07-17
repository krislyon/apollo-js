import { ActionExecutionError, UnknownImplementationError } from "./errors.js";
import type {
  ActionResult, ExecutionMeta, Implementations, MachineOptions, PreparedAction, Reference, StateMachineDefinition,
  StateSnapshot, TransitionDefinition, TransitionResult
} from "./types.js";
import { normalizeTransitions, referenceName, referenceParams, validateDefinition } from "./validation.js";
import { withTelemetrySpan, type TelemetrySpan } from "./telemetry.js";

export class StateMachine<Context extends Record<string, unknown>, Event extends { type: string }> {
  readonly #definition: StateMachineDefinition;
  readonly #implementations: Implementations<Context, Event>;
  readonly #strict: boolean;
  readonly #twoPhaseCommit: boolean;
  readonly #telemetryEnabled: boolean;
  readonly #tracerName: string;
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
    this.#telemetryEnabled = options.telemetry !== false;
    this.#tracerName = typeof options.telemetry === "object"
      ? options.telemetry.tracerName ?? "json-state-machine"
      : "json-state-machine";
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
          phase: "entry",
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
    const source = this.#state;
    return this.#span("transition", {
      "state_machine.event": event.type,
      "state_machine.source": source,
    }, async span => {
      const stateDefinition = this.#definition.states[this.#state];
      const candidates = stateDefinition?.on && Object.hasOwn(stateDefinition.on, event.type)
        ? stateDefinition.on[event.type]
        : undefined;
      if (!candidates) {
        span?.setAttribute("state_machine.outcome", "unhandled");
        return { transitioned: false, snapshot: this.snapshot };
      }

      let selected: TransitionDefinition | undefined;
      for (const candidate of normalizeTransitions(candidates)) {
        if (await this.#passes(candidate.guards ?? [], event, source, candidate.target)) {
          selected = candidate;
          break;
        }
      }
      if (!selected) {
        span?.setAttribute("state_machine.outcome", "guard_rejected");
        return { transitioned: false, snapshot: this.snapshot };
      }

      span?.setAttribute("state_machine.target", selected.target);
      const context = await this.#executeActions(this.#context, [
        { references: stateDefinition?.exit ?? [], source, target: selected.target, phase: "exit" },
        { references: selected.actions ?? [], source, target: selected.target, phase: "transition" },
        { references: this.#definition.states[selected.target]?.entry ?? [], source, target: selected.target, phase: "entry" },
      ], event);
      this.#context = context;
      this.#state = selected.target;
      span?.setAttribute("state_machine.outcome", "transitioned");
      return { transitioned: true, snapshot: this.snapshot };
    });
  }

  async #passes(references: Reference[], event: Event, source: string, target: string): Promise<boolean> {
    for (const reference of references) {
      const name = referenceName(reference);
      const passed = await this.#span("guard", this.#behaviorAttributes(name, event, source, target), async span => {
        const guards = this.#implementations.guards;
        const guard = guards && Object.hasOwn(guards, name) ? guards[name] : undefined;
        if (!guard) {
          span?.setAttribute("state_machine.outcome", "missing");
          if (this.#strict) throw new UnknownImplementationError(`Guard '${name}' is not registered`);
          return false;
        }
        const result = await guard(structuredClone(this.#context), event, this.#meta(reference, event, source, target));
        span?.setAttribute("state_machine.outcome", result ? "passed" : "failed");
        return result;
      });
      if (!passed) return false;
    }
    return true;
  }

  async #runActions(context: Context, references: Reference[], event: Event, source: string, target: string, phase: string): Promise<Context> {
    for (const reference of references) {
      const name = referenceName(reference);
      const result = await this.#span("action", {
        ...this.#behaviorAttributes(name, event, source, target),
        "state_machine.action.phase": phase,
      }, async span => {
        const actions = this.#implementations.actions;
        const action = actions && Object.hasOwn(actions, name) ? actions[name] : undefined;
        if (!action) {
          span?.setAttribute("state_machine.outcome", "missing");
          if (this.#strict) throw new UnknownImplementationError(`Action '${name}' is not registered`);
          return undefined;
        }
        try {
          const result = await action(structuredClone(context), event, this.#meta(reference, event, source, target, context));
          span?.setAttribute("state_machine.outcome", "succeeded");
          return result;
        } catch (cause) {
          span?.setAttribute("state_machine.outcome", "failed");
          throw new ActionExecutionError(`Action '${name}' failed while transitioning '${source}' -> '${target}'`, cause);
        }
      });
      context = applyResult(context, result === undefined ? undefined : structuredClone(result) as ActionResult<Context>);
    }
    return context;
  }

  async #executeActions(context: Context, steps: ActionStep[], event: Event): Promise<Context> {
    if (this.#twoPhaseCommit) return this.#runTransactionalActions(context, steps, event);
    for (const step of steps) context = await this.#runActions(context, step.references, event, step.source, step.target, step.phase);
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

  #behaviorAttributes(name: string, event: Event, source: string, target: string) {
    return {
      "state_machine.behavior": name,
      "state_machine.event": event.type,
      "state_machine.source": source,
      "state_machine.target": target,
    };
  }

  #span<T>(kind: "guard" | "action" | "transition", attributes: Record<string, string>, operation: (span: TelemetrySpan | undefined) => Promise<T>): Promise<T> {
    return withTelemetrySpan(
      this.#telemetryEnabled,
      this.#tracerName,
      `state_machine.${kind}`,
      { "state_machine.id": this.#definition.id, ...attributes },
      operation,
    );
  }

  #meta(reference: Reference, event: Event, source: string, target: string, context = this.#context): ExecutionMeta<Context, Event> {
    return {
      definition: structuredClone(this.#definition), source, target, event,
      snapshot: Object.freeze({ ...this.snapshot, context: structuredClone(context) }),
      params: structuredClone(referenceParams(reference)),
    };
  }
}

interface ActionStep { references: Reference[]; source: string; target: string; phase: string }

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
