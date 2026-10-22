import { onShutdown } from '@erp/observability';

import { jobs, startWorker } from './jobs';

const stop = startWorker();
onShutdown(stop);
console.info(`worker started with ${jobs.length} jobs`);
