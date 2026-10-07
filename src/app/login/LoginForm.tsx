"use client";

import { Loader2 } from "lucide-react";
import { useActionState, useState } from "react";
import { Button, Field, inputClass } from "@/components/ui";
import { authAction } from "./actions";

export function LoginForm({ next }: { next: string }) {
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [state, action, pending] = useActionState(authAction, {});
  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="mode" value={mode} />
      <input type="hidden" name="next" value={next} />
      {mode === "signup" && (
        <Field label="Your name">
          <input name="name" className={inputClass} autoComplete="name" placeholder="Jordan Avery" />
        </Field>
      )}
      <Field label="Email">
        <input name="email" type="email" required className={inputClass} autoComplete="email" placeholder="you@brokerage.com" />
      </Field>
      <Field label="Password">
        <input
          name="password"
          type="password"
          required
          minLength={8}
          className={inputClass}
          autoComplete={mode === "signup" ? "new-password" : "current-password"}
        />
      </Field>
      {state.error && <p className="rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700">{state.error}</p>}
      {state.notice && <p className="rounded-xl bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{state.notice}</p>}
      <Button type="submit" size="lg" className="w-full" disabled={pending}>
        {pending && <Loader2 className="size-4 animate-spin" />}
        {mode === "signin" ? "Sign in" : "Create account"}
      </Button>
      <p className="text-center text-sm text-neutral-500">
        {mode === "signin" ? "New to Atrium?" : "Already have an account?"}{" "}
        <button
          type="button"
          className="font-medium text-ink underline-offset-4 hover:underline"
          onClick={() => setMode(mode === "signin" ? "signup" : "signin")}
        >
          {mode === "signin" ? "Create an account" : "Sign in"}
        </button>
      </p>
    </form>
  );
}
