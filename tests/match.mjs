// Partial deep match: only keys present in `expected` are checked.
export function mismatches(actual, expected, at = "") {
  const show = (v) => JSON.stringify(v);
  if (expected && typeof expected === "object" && !Array.isArray(expected)) {
    if ("$range" in expected) {
      const [lo, hi] = expected.$range;
      return typeof actual === "number" && actual >= lo && actual <= hi ? [] : [`${at}: expected ${lo}–${hi}, got ${show(actual)}`];
    }
    if ("$match" in expected) return new RegExp(expected.$match, "i").test(String(actual ?? "")) ? [] : [`${at}: expected /${expected.$match}/i, got ${show(actual)}`];
    if ("$absent" in expected) return actual == null ? [] : [`${at}: expected nothing, got ${show(actual)}`];
    if (actual == null || typeof actual !== "object") return [`${at}: expected an object, got ${show(actual)}`];
    return Object.entries(expected).flatMap(([k, v]) => mismatches(actual[k], v, at ? `${at}.${k}` : k));
  }
  return show(actual) === show(expected) ? [] : [`${at}: expected ${show(expected)}, got ${show(actual)}`];
}
