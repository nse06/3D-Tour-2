"use client";

import { Loader2 } from "lucide-react";
import { useActionState } from "react";
import { Button, Field, inputClass } from "@/components/ui";
import { updatePasswordAction } from "../login/actions";

export function NewPasswordForm() {
  const [state, action, pending] = useActionState(updatePasswordAction, {});
  return (
    <form action={action} className="space-y-4">
      <Field label="New password">
        <input name="password" type="password" required minLength={8} className={inputClass} autoComplete="new-password" />
      </Field>
      <Field label="Type it again">
        <input name="confirm" type="password" required minLength={8} className={inputClass} autoComplete="new-password" />
      </Field>
      {state.error && <p className="rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700">{state.error}</p>}
      <Button type="submit" size="lg" className="w-full" disabled={pending}>
        {pending && <Loader2 className="size-4 animate-spin" />}
        Save the new password
      </Button>
    </form>
  );
}
