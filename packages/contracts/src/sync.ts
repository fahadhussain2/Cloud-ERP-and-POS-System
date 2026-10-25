import { z } from 'zod';

// Counter sync contracts (sync spec v1, W1-02, D-089). Shared by the API and the POS.

export const PULL_DATASETS = ['tenant', 'branch', 'users', 'roles', 'user_roles'] as const;
export type PullDataset = (typeof PULL_DATASETS)[number];

export const PULL_LIMIT_DEFAULT = 500;
export const PULL_LIMIT_MAX = 1000;

export interface PullResponse {
  /** Changed rows per dataset, with only that dataset's listed columns. */
  changes: Partial<Record<PullDataset, Record<string, unknown>[]>>;
  /** Opaque: store it and send it back unchanged. */
  cursor: string;
  hasMore: boolean;
}

/** A manager gives someone a temporary PIN in the back office. */
export const TemporaryPinRequest = z.object({ pin: z.string().min(1).max(12) });

/** A counter replaces a temporary PIN with the person's own (sync spec §5). */
export const CounterPinChangeRequest = z.object({
  userId: z.uuid(),
  currentPin: z.string().min(1).max(12),
  newPin: z.string().min(1).max(12),
});
export type CounterPinChangeRequest = z.infer<typeof CounterPinChangeRequest>;
