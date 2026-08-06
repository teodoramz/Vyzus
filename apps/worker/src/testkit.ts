// Library entry (`@vyzus/worker/testkit`) exposing the worker's building
// blocks WITHOUT the side-effecting `main()` in index.ts, so the API's
// full-stack smoke test can spin up a real worker in-process.
export { createProcessor, type ProcessorDeps } from './processor.js';
export { ArtifactStore } from './artifacts.js';
export { closeBrowser } from './browser.js';
export { createWorkerDb } from './db.js';
export { loadWorkerConfig, type WorkerConfig } from './config.js';
