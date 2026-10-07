"use client";

import { Check, Copy } from "lucide-react";
import { useState } from "react";

/** A scrollable code block with a one-click copy button. */
export function CopyBlock({ text, label = "Copy SQL" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="relative overflow-hidden rounded-2xl border border-sand bg-[#1b1a18]">
      <button
        type="button"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(text);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          } catch {
            window.prompt("Copy this text", text);
          }
        }}
        className="absolute right-3 top-3 inline-flex items-center gap-1.5 rounded-full bg-white px-3 py-1.5 text-xs font-medium text-ink shadow"
      >
        {copied ? <Check className="size-3.5 text-emerald-600" /> : <Copy className="size-3.5" />}
        {copied ? "Copied" : label}
      </button>
      <pre className="max-h-80 overflow-auto p-5 pr-28 font-mono text-[12px] leading-relaxed text-white/80">{text}</pre>
    </div>
  );
}
