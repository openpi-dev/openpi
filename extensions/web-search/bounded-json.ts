/** Exact JSON UTF-8 accounting without allocating an encoding or serialized copy. */
export function jsonStringBytes(value: string, limit: number) {
  let bytes = 2;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code === 34 || code === 92 || [8, 9, 10, 12, 13].includes(code))
      bytes += 2;
    else if (code < 32) bytes += 6;
    else if (code < 128) bytes++;
    else if (code < 2048) bytes += 2;
    else if (
      code >= 0xd800 &&
      code <= 0xdbff &&
      value.charCodeAt(i + 1) >= 0xdc00 &&
      value.charCodeAt(i + 1) <= 0xdfff
    ) {
      bytes += 4;
      i++;
    } else bytes += code >= 0xd800 && code <= 0xdfff ? 6 : 3;
    if (bytes > limit) return undefined;
  }
  return bytes <= limit ? bytes : undefined;
}

/** Structure limits derive from the byte budget (even empty JSON nodes cost bytes). */
export function admittedJsonBytes(value: unknown, limit: number) {
  let bytes = 0;
  let nodes = 0;
  const ancestors = new Set<object>();
  const visit = (item: unknown, depth: number): boolean => {
    if (++nodes > limit || depth > Math.min(512, limit) || bytes > limit)
      return false;
    if (item === null || typeof item === "boolean")
      bytes += item === null ? 4 : item ? 4 : 5;
    else if (typeof item === "number") {
      if (!Number.isFinite(item)) return false;
      bytes += String(item).length;
    } else if (typeof item === "string") {
      const size = jsonStringBytes(item, limit - bytes);
      if (size === undefined) return false;
      bytes += size;
    } else if (typeof item === "object") {
      if (
        ancestors.has(item) ||
        (!Array.isArray(item) &&
          Object.getPrototypeOf(item) !== Object.prototype &&
          Object.getPrototypeOf(item) !== null)
      )
        return false;
      ancestors.add(item);
      bytes += 2;
      let count = 0;
      if (Array.isArray(item)) {
        const length = Object.getOwnPropertyDescriptor(item, "length");
        if (
          Object.getPrototypeOf(item) !== Array.prototype ||
          Object.getOwnPropertyDescriptor(item, Symbol.iterator) ||
          !length ||
          !("value" in length) ||
          typeof length.value !== "number" ||
          length.value > limit - bytes
        )
          return false;
        // Clone retains enumerable extras that JSON omits. Validate keys without
        // collecting an unbounded list or reading their values.
        for (const key in item) {
          if (!Object.hasOwn(item, key)) continue;
          if (key.length > String(length.value).length) return false;
          const index = Number(key);
          if (
            ++count > length.value ||
            !Number.isInteger(index) ||
            index < 0 ||
            index >= length.value ||
            String(index) !== key
          )
            return false;
        }
        if (count !== length.value) return false;
        for (let index = 0; index < length.value; index++) {
          if (index) bytes++;
          const descriptor = Object.getOwnPropertyDescriptor(
            item,
            String(index),
          );
          if (
            !descriptor ||
            !("value" in descriptor) ||
            !visit(descriptor.value, depth + 1)
          )
            return false;
        }
      } else {
        for (const key in item) {
          if (!Object.hasOwn(item, key)) continue;
          if (count++) bytes++;
          const size = jsonStringBytes(key, limit - bytes);
          if (size === undefined) return false;
          bytes += size + 1;
          const descriptor = Object.getOwnPropertyDescriptor(item, key);
          if (
            !descriptor ||
            !("value" in descriptor) ||
            !visit(descriptor.value, depth + 1)
          )
            return false;
        }
      }
      ancestors.delete(item);
    } else return false;
    return bytes <= limit;
  };
  return visit(value, 0) ? bytes : undefined;
}

/** Compare an assigned tool-input projection without serializing ordinary payloads. */
export function sameJsonValue(
  left: unknown,
  right: unknown,
  depth = 0,
): boolean {
  if (left === right) return true;
  if (
    depth > 512 ||
    typeof left !== "object" ||
    left === null ||
    typeof right !== "object" ||
    right === null ||
    Array.isArray(left) !== Array.isArray(right)
  )
    return false;
  const a = left as Record<string, unknown>,
    b = right as Record<string, unknown>;
  let count = 0;
  for (const key in a) {
    if (!Object.hasOwn(a, key)) continue;
    if (!Object.hasOwn(b, key) || !sameJsonValue(a[key], b[key], depth + 1))
      return false;
    count++;
  }
  for (const key in b) if (Object.hasOwn(b, key)) count--;
  return (
    count === 0 &&
    (!Array.isArray(left) || left.length === (right as unknown[]).length)
  );
}
