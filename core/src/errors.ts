export function createHttpError(status: number, message: string): Error {
  return Object.assign(new Error(message), { status });
}

export function isHttpError(err: unknown): err is Error & { status: number } {
  return err instanceof Error && typeof (err as unknown as Record<string, unknown>).status === "number";
}
