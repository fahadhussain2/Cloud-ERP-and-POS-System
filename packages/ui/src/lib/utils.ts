import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** Joins class names; a later Tailwind class wins over an earlier one of the same kind (shadcn/ui's `cn`). */
export const cn = (...inputs: ClassValue[]): string => twMerge(clsx(inputs));
