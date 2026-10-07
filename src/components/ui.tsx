import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";

type Variant = "primary" | "secondary" | "ghost" | "danger" | "gold";

const variants: Record<Variant, string> = {
  primary: "bg-ink text-white hover:bg-neutral-800 shadow-sm",
  secondary: "bg-white text-ink border border-sand hover:border-neutral-400 shadow-sm",
  ghost: "text-neutral-600 hover:bg-black/5 hover:text-ink",
  danger: "text-red-700 hover:bg-red-50",
  gold: "bg-gold text-white hover:brightness-105 shadow-sm",
};

export function buttonClass(variant: Variant = "primary", size: "sm" | "md" | "lg" = "md") {
  const sizes = { sm: "h-9 px-3.5 text-[13px]", md: "h-11 px-5 text-sm", lg: "h-12 px-6 text-[15px]" };
  return `inline-flex items-center justify-center gap-2 rounded-full font-medium transition disabled:pointer-events-none disabled:opacity-50 ${sizes[size]} ${variants[variant]}`;
}

export function Button({ variant = "primary", size = "md", className = "", ...props }: ComponentProps<"button"> & { variant?: Variant; size?: "sm" | "md" | "lg" }) {
  return <button {...props} className={`${buttonClass(variant, size)} ${className}`} />;
}

export function ButtonLink({ variant = "primary", size = "md", className = "", ...props }: ComponentProps<typeof Link> & { variant?: Variant; size?: "sm" | "md" | "lg" }) {
  return <Link {...props} className={`${buttonClass(variant, size)} ${className}`} />;
}

export function Card({ className = "", children }: { className?: string; children: ReactNode }) {
  return <div className={`rounded-3xl border border-sand/80 bg-white shadow-[0_1px_2px_rgba(0,0,0,0.04),0_8px_28px_rgba(30,24,16,0.05)] ${className}`}>{children}</div>;
}

export function StatusPill({ published, className = "" }: { published: boolean; className?: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.12em] ${
        published ? "bg-emerald-50 text-emerald-800 ring-1 ring-emerald-200" : "bg-neutral-100 text-neutral-600 ring-1 ring-neutral-200"
      } ${className}`}
    >
      <span className={`size-1.5 rounded-full ${published ? "bg-emerald-500" : "bg-neutral-400"}`} />
      {published ? "Published" : "Draft"}
    </span>
  );
}

export function Field({ label, error, hint, children, className = "" }: { label: string; error?: string; hint?: string; children: ReactNode; className?: string }) {
  return (
    <label className={`block ${className}`}>
      <span className="mb-1.5 block text-[12px] font-semibold uppercase tracking-[0.12em] text-neutral-500">{label}</span>
      {children}
      {error ? <span className="mt-1 block text-xs text-red-600">{error}</span> : hint ? <span className="mt-1 block text-xs text-neutral-400">{hint}</span> : null}
    </label>
  );
}

export const inputClass =
  "w-full rounded-xl border border-sand bg-white px-3.5 py-2.5 text-[15px] text-ink placeholder:text-neutral-400 shadow-[inset_0_1px_1px_rgba(0,0,0,0.03)] outline-none transition focus:border-neutral-400 focus:ring-4 focus:ring-gold/15";

export function Wordmark({ className = "" }: { className?: string }) {
  return (
    <span className={`font-display text-[26px] leading-none tracking-tight ${className}`}>
      Atrium<span className="text-gold">.</span>
    </span>
  );
}
