import { useEffect, useRef, type ReactNode } from 'react';

import { cn } from './cn';

// A list the keyboard moves through while focus stays in a search box (POS-03): the box owns ↑ ↓ and asks
// moveSelection(); the list shows the selection, scrolls to it, and takes clicks.

/** The selection after a key press, or null for a key the list does not use. */
export function moveSelection(current: number, key: string, length: number): number | null {
  if (length === 0) return null;
  const last = length - 1;
  switch (key) {
    case 'ArrowDown':
      return Math.min(last, current + 1);
    case 'ArrowUp':
      return Math.max(0, current - 1);
    case 'PageDown':
      return Math.min(last, current + 10);
    case 'PageUp':
      return Math.max(0, current - 10);
    default:
      return null;
  }
}

export function OptionList<T>({
  id,
  label,
  items,
  selected,
  itemKey,
  onSelect,
  onChoose,
  children,
  className,
}: {
  id: string;
  label: string;
  items: readonly T[];
  selected: number;
  itemKey: (item: T) => string;
  onSelect: (index: number) => void;
  /** A double click: the same as Enter on the selected item. */
  onChoose?: (index: number) => void;
  children: (item: T, selected: boolean) => ReactNode;
  className?: string;
}) {
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = list.current?.querySelector<HTMLElement>('[aria-selected="true"]');
    el?.scrollIntoView?.({ block: 'nearest' });
  }, [selected, items]);
  return (
    <div
      ref={list}
      id={id}
      role="listbox"
      aria-label={label}
      className={cn('min-h-0 overflow-auto', className)}
    >
      {items.map((item, i) => (
        <div
          key={itemKey(item)}
          id={`${id}-${i}`}
          role="option"
          aria-selected={i === selected}
          onClick={() => onSelect(i)}
          onDoubleClick={() => onChoose?.(i)}
          className="cursor-pointer rounded-[7px] hover:bg-surface-2 aria-selected:bg-select"
        >
          {children(item, i === selected)}
        </div>
      ))}
    </div>
  );
}
