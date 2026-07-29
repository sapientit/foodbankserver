/**
 * A partial update where an absent key and an explicit `undefined` mean the
 * same thing.
 *
 * `exactOptionalPropertyTypes` makes plain `Partial<T>` reject `{ name:
 * undefined }`, which is precisely what you get from spreading a parsed
 * partial request body. Rather than casting at every call site, patch-shaped
 * parameters use this type — and only patch-shaped parameters, so the
 * strictness still applies everywhere it should.
 */
export type Patch<T> = { [K in keyof T]?: T[K] | undefined };
