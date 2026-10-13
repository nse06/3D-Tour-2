"use client";

import { Loader2, Trash2 } from "lucide-react";
import { useActionState, useState } from "react";
import { deleteAccountAction } from "@/app/dashboard/actions";
import { inputClass } from "@/components/ui";

export function DeleteAccountForm() {
  const [state, action, pending] = useActionState(deleteAccountAction, {});
  const [typed, setTyped] = useState("");
  return (
    <form action={action} className="mt-6 space-y-3">
      <label className="block text-sm text-neutral-600" htmlFor="confirm">
        Type <b className="font-semibold text-ink">DELETE</b> to confirm
      </label>
      <input id="confirm" name="confirm" autoComplete="off" className={`${inputClass} block max-w-xs`} value={typed} onChange={(e) => setTyped(e.target.value)} />
      {state.error && <p className="max-w-md rounded-xl bg-red-50 px-3 py-2 text-sm text-red-800">{state.error}</p>}
      <button
        type="submit"
        disabled={pending || typed.trim().toUpperCase() !== "DELETE"}
        className="inline-flex h-11 items-center gap-2 rounded-full bg-red-700 px-5 text-sm font-medium text-white transition hover:bg-red-800 disabled:opacity-40"
      >
        {pending ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />} Delete my account
      </button>
    </form>
  );
}
