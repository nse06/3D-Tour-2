"use client";

import { Check, Link2 } from "lucide-react";
import { useState } from "react";
import { buttonClass } from "@/components/ui";

/** Copies an absolute tour URL (built from the current origin) to the clipboard. */
export function CopyLinkButton({
  path,
  label = "Share",
  variant = "secondary",
  size = "sm",
  disabled,
  className = "",
}: {
  path: string;
  label?: string;
  variant?: "primary" | "secondary" | "ghost" | "gold";
  size?: "sm" | "md" | "lg";
  disabled?: boolean;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      disabled={disabled}
      title={disabled ? "Publish the tour to share it" : "Copy the public tour link"}
      onClick={async () => {
        const url = new URL(path, window.location.origin).toString();
        try {
          await navigator.clipboard.writeText(url);
        } catch {
          window.prompt("Copy this link", url);
        }
        setCopied(true);
        setTimeout(() => setCopied(false), 1800);
      }}
      className={`${buttonClass(variant, size)} ${className}`}
    >
      {copied ? <Check className="size-4 text-emerald-600" /> : <Link2 className="size-4" />}
      {copied ? "Link copied" : label}
    </button>
  );
}
