export interface ErrorResponse {
  ok: false;
  status: number;
  headers: Record<string, string>;
  body: unknown;
  url: string;
}

export interface ErrorBindings {
  /** What `fetch` attaches: read it as `{ "var": "$response.body" }` inside `catch`. */
  response?: ErrorResponse;
  [key: string]: unknown;
}

export type HttpError = Error & { status: number; bindings?: ErrorBindings };

export function createHttpError(status: number, message: string, bindings?: ErrorBindings): HttpError {
  const err: HttpError = Object.assign(new Error(message), { status });
  if (bindings) err.bindings = bindings;
  return err;
}

export function isHttpError(err: unknown): err is HttpError {
  return err instanceof Error && typeof (err as unknown as Record<string, unknown>).status === "number";
}
