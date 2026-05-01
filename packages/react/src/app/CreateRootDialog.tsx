// Prompt for $type when creating the tree root node.

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '#components/ui/alert-dialog';
import { Input } from '#components/ui/input';
import { useEffect, useState } from 'react';

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate: (type: string) => void;
  defaultType?: string;
};

export function CreateRootDialog({ open, onOpenChange, onCreate, defaultType = 'root' }: Props) {
  const [type, setType] = useState(defaultType);

  // Reset to defaultType every time the dialog opens — matches the original
  // Editor behavior where setRootPromptType('root') ran before setRootPromptOpen(true).
  useEffect(() => { if (open) setType(defaultType); }, [open, defaultType]);

  const submit = () => {
    onOpenChange(false);
    onCreate(type);
  };

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Create root node</AlertDialogTitle>
        </AlertDialogHeader>
        <Input
          value={type}
          onChange={(e) => setType(e.target.value)}
          placeholder="$type"
          className="font-mono"
          onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
        />
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={submit}>Create</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
