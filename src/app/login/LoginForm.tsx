"use client";

import { Loader2 } from "lucide-react";
import { useActionState, useState } from "react";
import { Button, Field, inputClass } from "@/components/ui";
import { authAction } from "./actions";

type Mode = "signin" | "signup" | "reset";

export function LoginForm({ next, initialMode = "signin" }: { next: string; initialMode?: Mode }) {
  const [mode, setMode] = useState<Mode>(initialMode);
  const [state, action, pending] = useActionState(authAction, {});
  // Kept in state: React resets a form after its action runs, and a wrong password shouldn't wipe the email.
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="mode" value={mode} />
      <input type="hidden" name="next" value={next} />
      {mode === "signup" && (
        <Field label="Your name">
          <input
            name="name"
            className={inputClass}
            autoComplete="name"
            placeholder="Jordan Avery"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
      )}
      <Field label="Email">
        <input
          name="email"
          type="email"
          required
          className={inputClass}
          autoComplete="email"
          placeholder="you@brokerage.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </Field>
      {mode !== "reset" && (
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
      )}
      {mode === "signin" && (
        <p className="-mt-2 text-right text-sm">
          <button type="button" className="text-neutral-500 underline-offset-4 hover:text-ink hover:underline" onClick={() => setMode("reset")}>
            Forgot your password?
          </button>
        </p>
      )}
      {mode === "reset" && <p className="text-sm text-neutral-600">We&apos;ll email you a link to set a new password.</p>}
      {state.error && <p className="rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700">{state.error}</p>}
      {state.notice && <p className="rounded-xl bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{state.notice}</p>}
      {mode === "signup" && (
        <p className="text-xs leading-relaxed text-neutral-500">
          By creating an account you agree to the{" "}
          <a href="/legal/terms" target="_blank" className="underline underline-offset-2">
            Terms of Service
          </a>{" "}
          and confirm you&apos;ve read the{" "}
          <a href="/legal/privacy" target="_blank" className="underline underline-offset-2">
            Privacy Policy
          </a>
          .
        </p>
      )}
      <Button type="submit" size="lg" className="w-full" disabled={pending}>
        {pending && <Loader2 className="size-4 animate-spin" />}
        {mode === "signin" ? "Sign in" : mode === "signup" ? "Create account" : "Send reset link"}
      </Button>
      <p className="text-center text-sm text-neutral-500">
        {mode === "signin" ? "New to Atrium?" : mode === "signup" ? "Already have an account?" : "Remembered it?"}{" "}
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
