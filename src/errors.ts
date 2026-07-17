export class StateMachineError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class InvalidDefinitionError extends StateMachineError {}
export class UnknownImplementationError extends StateMachineError {}
export class ActionExecutionError extends StateMachineError {
  public override readonly cause: unknown;
  public constructor(message: string, cause: unknown) {
    super(message);
    this.cause = cause;
  }
}
