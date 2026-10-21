export interface Job {
  name: string;
  run: () => Promise<void>;
}

// Background jobs (reconciliation, reports, reorder list, notifications) are registered here.
export const jobs: readonly Job[] = [];
