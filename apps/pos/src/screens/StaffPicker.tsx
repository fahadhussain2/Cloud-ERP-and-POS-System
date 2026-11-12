import { Button, TextField } from '@erp/ui';
import { useState } from 'react';

import type { StaffUser } from '../unlock/unlock';

/** The staff names as buttons, and the short-code field that picks one as soon as it matches. */
export function StaffPicker({
  staff,
  onPick,
  shortCodeLabel,
}: {
  staff: StaffUser[];
  onPick: (u: StaffUser) => void;
  shortCodeLabel: string;
}) {
  const [shortCode, setShortCode] = useState('');
  const typeShortCode = (value: string) => {
    setShortCode(value);
    const match = staff.find((u) => u.shortCode !== null && u.shortCode === value.trim());
    if (match) onPick(match);
  };
  return (
    <>
      <ul className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(12rem,1fr))] gap-2 p-0">
        {staff.map((u) => (
          <li key={u.id}>
            <Button variant="outline" size="lg" className="w-full justify-between" onClick={() => onPick(u)}>
              {u.fullName}
              {u.shortCode && <span className="font-mono text-muted-foreground">{u.shortCode}</span>}
            </Button>
          </li>
        ))}
      </ul>
      <TextField
        label={shortCodeLabel}
        inputMode="numeric"
        autoComplete="off"
        className="font-mono"
        value={shortCode}
        onChange={(e) => typeShortCode(e.target.value)}
      />
    </>
  );
}
