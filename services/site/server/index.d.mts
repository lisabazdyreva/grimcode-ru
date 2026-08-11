/**
 * Types for the Node entry of the site.
 *
 * `index.mjs` is handwritten JavaScript — tsc never compiles it, so nothing else would describe
 * it. The extension has to be `.d.mts`: this workspace resolves modules as NodeNext, which picks
 * declarations by the file extension, and a `.d.ts` next to an `.mjs` is not found at all
 * (`TS7016: Could not find a declaration file`).
 *
 * Today the entry starts the server as a side effect of being imported and exports nothing, so
 * this file says exactly that. When the site gains a `createApp()` its signature belongs here.
 */
export {};
