import type { ReactNode } from 'react';

import { Badge } from './components/ui/badge';
import { cn } from './lib/utils';

export type ChipTone = 'ok' | 'warn' | 'bad' | 'accent' | 'neutral';

const TONES: Record<ChipTone, string> = {
  ok: 'bg-ok-soft text-ok',
  warn: 'bg-warn-soft text-warn',
  bad: 'bg-bad-soft text-bad',
  accent: 'bg-primary-soft text-primary',
  neutral: 'border-line bg-surface-2 text-muted-foreground',
};

/** A short state chip in the prototype's colours (Active, Deactivated, Locked, PIN states…), on shadcn/ui's Badge. */
export function StatusChip({ tone, children }: { tone: ChipTone; children: ReactNode }) {
  return (
    <Badge variant="outline" data-tone={tone} className={cn('font-semibold', TONES[tone])}>
      {children}
    </Badge>
  );
}
