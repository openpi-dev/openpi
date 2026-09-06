/**
 * Promise.withResolvers type shim.
 *
 * The repo tsconfig targets ES2022 libs, but openpi runs on Node >=22.19
 * (package.json engines), where Promise.withResolvers is available since
 * Node 22.0. This declaration matches lib.es2024.promise.withresolvers.d.ts.
 */

declare global {
  interface PromiseConstructor {
    withResolvers<T>(): {
      promise: Promise<T>;
      resolve: (value: T | PromiseLike<T>) => void;
      reject: (reason?: unknown) => void;
    };
  }
}

export {};
