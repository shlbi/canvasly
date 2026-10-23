// The production worker has its own Playwright dependency and runs outside Vercel Functions.
import { startWorker } from '../worker/server.mjs';
const worker = await startWorker();
process.once('SIGTERM', /* Persist browser state and settle the current bounded step before exiting. */ () => worker.stop().then(/* End after cleanup, not while an external write is pending. */ () => process.exit(0)));
process.once('SIGINT', /* Handle local shutdown with the same durability guarantee. */ () => worker.stop().then(/* Exit only after cleanup completes. */ () => process.exit(0)));
console.log('Canvasly cloud worker started.');
