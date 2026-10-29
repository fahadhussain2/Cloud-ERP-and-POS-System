// Posting engine: document -> stock, party and GL entries (server only, CLAUDE.md rule 4).
export { averageAfterReceipt } from './cost';
export { postDocument, postPending, type PostOutcome, type SourceType } from './db/post';
export { applyRebuild, checkRebuild, RebuildRefused, type RebuildCheck } from './db/rebuild';
export { emptyState, replay, type ReplayStep } from './replay';
export { postSale } from './sale';
export type {
  CostState,
  JournalLine,
  LedgerState,
  PartyEntry,
  Posting,
  PostingContext,
  PostingError,
  PostingException,
  PostingResult,
  PostingRole,
  PostingSale,
  PostingSaleLine,
  StockMovement,
} from './types';
