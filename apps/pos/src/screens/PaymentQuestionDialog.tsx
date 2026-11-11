import { Button } from '@erp/ui';
import type { ReactNode } from 'react';

import { Facts, FormDialog } from './BillDialogs';

// The payment question before a void or a return (W1-23, D-111): where the counter can't know whether a payment part
// has reached the shop (the desk's cash while offline; a bank, wallet or card payment always), the person is asked.
// Enter answers yes (the money has arrived), the other button no; Esc leaves the bill as it is.

export function PaymentQuestionDialog({
  title,
  question,
  help,
  facts,
  yes,
  no,
  onAnswer,
  onClose,
}: {
  title: string;
  question: string;
  help: string;
  facts: readonly (readonly [string, ReactNode])[];
  yes: string;
  no: string;
  onAnswer: (arrived: boolean) => void;
  onClose: () => void;
}) {
  return (
    <FormDialog
      title={title}
      description={question}
      actionLabel={yes}
      onSubmit={() => onAnswer(true)}
      onClose={onClose}
    >
      <p className="m-0 text-sm text-muted-foreground">{help}</p>
      <Facts facts={facts} />
      <Button type="button" variant="outline" className="self-start" onClick={() => onAnswer(false)}>
        {no}
      </Button>
    </FormDialog>
  );
}
