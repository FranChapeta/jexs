/** Whether the app runs in production, as `NODE_ENV` says (`jexs run --prod` sets it). */
export function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}
