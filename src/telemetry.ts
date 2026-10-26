type Attributes = Record<string, string | number | boolean>;

interface OtelSpan {
  setAttribute(name: string, value: string | number | boolean): this;
  setStatus(status: { code: number; message?: string }): this;
  recordException(exception: Error): void;
  end(): void;
}

interface OtelApi {
  trace: {
    getTracer(name: string): {
      startActiveSpan<T>(name: string, options: { attributes: Attributes }, callback: (span: OtelSpan) => T): T;
    };
  };
}

export interface TelemetrySpan {
  setAttribute(name: string, value: string | number | boolean): void;
}

const moduleName = "@opentelemetry/api";
let apiPromise: Promise<OtelApi | undefined> | undefined;

async function loadApi(): Promise<OtelApi | undefined> {
  apiPromise ??= import(moduleName)
    .then(module => module as unknown as OtelApi)
    .catch(() => undefined);
  return apiPromise;
}

export async function withTelemetrySpan<T>(
  enabled: boolean,
  tracerName: string,
  name: string,
  attributes: Attributes,
  operation: (span: TelemetrySpan | undefined) => Promise<T>,
): Promise<T> {
  if (!enabled) return operation(undefined);

  const api = await loadApi();
  if (!api) return operation(undefined);

  try {
    const tracer = api.trace.getTracer(tracerName);
    return await tracer.startActiveSpan(name, { attributes }, async span => {
      try {
        return await operation(span);
      } catch (cause) {
        const error = cause instanceof Error ? cause : new Error(String(cause));
        span.recordException(error);
        span.setStatus({ code: 2, message: error.message });
        throw new OperationError(cause);
      } finally {
        span.end();
      }
    });
  } catch (cause) {
    // Telemetry setup must not stop the state machine. Errors thrown by the
    // instrumented operation have already been rethrown from the callback.
    if (cause instanceof OperationError) throw cause.cause;
    return operation(undefined);
  }
}

class OperationError extends Error {
  public constructor(public override readonly cause: unknown) { super("Instrumented operation failed"); }
}
