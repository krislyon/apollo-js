export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface NamedReference {
  type: string;
  params?: Record<string, JsonValue>;
}

export type Reference = string | NamedReference;

export interface TransitionDefinition {
  target: string;
  guards?: Reference[];
  actions?: Reference[];
  description?: string;
}

export type TransitionValue = string | TransitionDefinition | TransitionDefinition[];

export interface StateDefinition {
  description?: string;
  entry?: Reference[];
  exit?: Reference[];
  on?: Record<string, TransitionValue>;
  final?: boolean;
  metadata?: Record<string, JsonValue>;
}

export interface StateMachineDefinition {
  id: string;
  version?: string;
  description?: string;
  initial: string;
  context?: Record<string, JsonValue>;
  states: Record<string, StateDefinition>;
  metadata?: Record<string, JsonValue>;
}

export interface StateSnapshot<Context> {
  readonly machineId: string;
  readonly state: string;
  readonly context: Readonly<Context>;
  readonly done: boolean;
}

export interface ExecutionMeta<Context, Event> {
  readonly definition: StateMachineDefinition;
  readonly source: string;
  readonly target: string;
  readonly event: Event;
  readonly snapshot: StateSnapshot<Context>;
  readonly params: Readonly<Record<string, JsonValue>>;
}

export type Guard<Context, Event> =
  (context: Readonly<Context>, event: Event, meta: ExecutionMeta<Context, Event>) => boolean | Promise<boolean>;

export type ActionResult<Context> = void | Context | Partial<Context>;
export type Action<Context, Event> =
  (context: Readonly<Context>, event: Event, meta: ExecutionMeta<Context, Event>) => ActionResult<Context> | Promise<ActionResult<Context>>;

export interface Implementations<Context, Event> {
  guards?: Record<string, Guard<Context, Event>>;
  actions?: Record<string, Action<Context, Event>>;
}

export interface MachineOptions {
  strictImplementations?: boolean;
}

export interface TransitionResult<Context> {
  readonly transitioned: boolean;
  readonly snapshot: StateSnapshot<Context>;
}
