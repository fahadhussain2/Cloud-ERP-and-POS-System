// The screens' building blocks (D-066). `components/ui/` comes from the shadcn/ui CLI (`pnpm --filter @erp/ui ui:add
// <name>`), themed through theme.css; the rest is ours: the frame, the keyboard layer, formatting. Fonts: import
// '@erp/ui/fonts' once per app.
export { Alert, AlertDescription, AlertTitle } from './components/ui/alert';
export { Badge, badgeVariants } from './components/ui/badge';
export { Button, buttonVariants } from './components/ui/button';
export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from './components/ui/dialog';
export { Input } from './components/ui/input';
export { Label } from './components/ui/label';
export { AppFrame } from './app-frame';
export { DialogActions } from './dialog-actions';
export { formatMoney, type MoneyFormat } from './format';
export { KeyBar, Kbd, type KeyHint } from './key-bar';
export { cn } from './lib/utils';
export { moveSelection, OptionList } from './option-list';
export { Panel } from './panel';
export { matchKey, useShortcuts, type KeyPress, type Shortcuts } from './shortcuts';
export { LABEL_CLASS, TextField } from './text-field';
