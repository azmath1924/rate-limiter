/** Returns the current time in seconds (Unix epoch). */
export function nowSeconds(): number {
  return Date.now() / 1000;
}
