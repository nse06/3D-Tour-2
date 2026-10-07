import Link from "next/link";
import { Wordmark } from "@/components/ui";

export default function NotFound() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-paper px-6 text-center">
      <Wordmark />
      <h1 className="font-display mt-10 text-5xl leading-tight">This tour isn&apos;t available</h1>
      <p className="mt-3 max-w-md text-neutral-600">The listing may have been unpublished, or the link is incomplete. Ask the agent for an updated link.</p>
      <div className="mt-8 flex gap-3">
        <Link href="/tour/sample" className="rounded-full bg-ink px-5 py-3 text-sm font-medium text-white hover:bg-neutral-800">
          Walk through a sample home
        </Link>
        <Link href="/" className="rounded-full px-5 py-3 text-sm font-medium text-neutral-600 ring-1 ring-sand hover:text-ink">
          Atrium home
        </Link>
      </div>
    </div>
  );
}
