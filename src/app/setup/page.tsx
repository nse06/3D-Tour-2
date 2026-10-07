import { ArrowRight, Database, ExternalLink, RefreshCw } from "lucide-react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { CopyBlock } from "@/components/setup/CopyBlock";
import { ButtonLink, Card, Wordmark } from "@/components/ui";
import { checkSetup, migrationsSourceUrl, migrationsSql } from "@/lib/setup";

export const dynamic = "force-dynamic";
export const metadata = { title: "Finish setup" };

/** Guided setup for fresh deployments: connect a database, then create the tables. */
export default async function SetupPage() {
  const status = await checkSetup();
  if (status.ok) redirect("/dashboard");
  const sql = status.reason === "missing-schema" ? await migrationsSql() : null;
  const sqlSource = migrationsSourceUrl();

  return (
    <div className="min-h-screen bg-paper">
      <header className="mx-auto flex max-w-3xl items-center justify-between px-5 py-6">
        <Link href="/">
          <Wordmark />
        </Link>
        <Link href="/tour/sample" className="text-sm text-neutral-600 hover:text-ink">
          Sample tour
        </Link>
      </header>
      <main className="rise mx-auto max-w-3xl px-5 pb-24 pt-6">
        <p className="text-[12px] font-semibold uppercase tracking-[0.24em] text-stone">Finish setup</p>
        {status.reason === "no-database" && (
          <>
            <h1 className="font-display mt-3 text-5xl leading-[1.05]">Connect a database to save listings</h1>
            <p className="mt-4 text-[15px] leading-relaxed text-neutral-600">
              This deployment is live, but it doesn&apos;t have a database yet, so listings and iPhone scans can&apos;t be saved. The sample walkthrough works
              right now — connecting Supabase (free) takes about two minutes.
            </p>
            <Card className="mt-8 p-6 md:p-8">
              <Steps
                steps={[
                  <>
                    In <b className="font-medium text-ink">Vercel</b>, open this project → <b className="font-medium text-ink">Storage</b> →{" "}
                    <b className="font-medium text-ink">Create Database</b> → <b className="font-medium text-ink">Supabase</b> (free plan) → connect it to this
                    project.
                  </>,
                  <>
                    Redeploy: <b className="font-medium text-ink">Deployments</b> → the latest deployment → <b className="font-medium text-ink">⋯ → Redeploy</b>{" "}
                    (new environment variables apply to new deployments).
                  </>,
                  <>Come back to this page — it will hand you the SQL that creates Atrium&apos;s tables.</>,
                ]}
              />
              <div className="mt-8 flex flex-wrap gap-3">
                <ButtonLink href="https://vercel.com/dashboard" target="_blank">
                  Open Vercel <ExternalLink className="size-4" />
                </ButtonLink>
                <ButtonLink href="/tour/sample" variant="secondary">
                  Walk through the sample <ArrowRight className="size-4" />
                </ButtonLink>
              </div>
            </Card>
          </>
        )}
        {status.reason === "missing-schema" && (
          <>
            <h1 className="font-display mt-3 text-5xl leading-[1.05]">One last step: create the tables</h1>
            {status.autoSetupError && (
              <p className="mt-4 rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-900">
                Atrium tried to create them automatically but couldn&apos;t: {status.autoSetupError}
              </p>
            )}
            <p className="mt-4 text-[15px] leading-relaxed text-neutral-600">
              Your Supabase database is connected. Run Atrium&apos;s schema — it creates the listing tables, row-level security policies and the storage bucket
              for 3D captures. Ran it before an update? Run it again: it only adds what&apos;s new.
            </p>
            <Card className="mt-8 p-6 md:p-8">
              <Steps
                steps={[
                  <>
                    Open the Supabase <b className="font-medium text-ink">SQL editor</b> for your project
                    {status.projectRef ? "" : " (Supabase dashboard → your project → SQL Editor → New query)"}.
                  </>,
                  <>
                    Paste the SQL below and press <b className="font-medium text-ink">Run</b>.
                  </>,
                  <>
                    Optional, for quick testing: Supabase → <b className="font-medium text-ink">Authentication → Sign In / Providers → Email</b> → turn off{" "}
                    <b className="font-medium text-ink">Confirm email</b> so you can sign in right after signing up.
                  </>,
                ]}
              />
              <div className="mt-6 flex flex-wrap gap-3">
                <ButtonLink
                  href={status.projectRef ? `https://supabase.com/dashboard/project/${status.projectRef}/sql/new` : "https://supabase.com/dashboard/projects"}
                  target="_blank"
                >
                  <Database className="size-4" /> Open SQL editor <ExternalLink className="size-4" />
                </ButtonLink>
                <ButtonLink href="/setup" variant="secondary">
                  <RefreshCw className="size-4" /> I ran it — check again
                </ButtonLink>
              </div>
              <div className="mt-6">
                {sql ? (
                  <CopyBlock text={sql} />
                ) : (
                  <p className="text-sm text-neutral-600">
                    Paste every file from the repository&apos;s <code className="font-mono">supabase/migrations</code> folder, in order
                    {sqlSource && (
                      <>
                        {" "}
                        —{" "}
                        <a href={sqlSource} target="_blank" className="underline underline-offset-4">
                          open them on GitHub
                        </a>
                      </>
                    )}
                    .
                  </p>
                )}
              </div>
              <p className="mt-3 text-xs text-neutral-500">Missing tables: {status.missing.join(", ")}.</p>
            </Card>
          </>
        )}
        {status.reason === "unreachable" && (
          <>
            <h1 className="font-display mt-3 text-5xl leading-[1.05]">Can&apos;t reach the database</h1>
            <p className="mt-4 text-[15px] leading-relaxed text-neutral-600">Supabase answered with an error: {status.message}</p>
            <p className="mt-2 text-[15px] text-neutral-600">
              Check the Supabase environment variables in Vercel (Settings → Environment Variables), then redeploy.
            </p>
          </>
        )}
      </main>
    </div>
  );
}

function Steps({ steps }: { steps: React.ReactNode[] }) {
  return (
    <ol className="space-y-4">
      {steps.map((s, i) => (
        <li key={i} className="flex gap-4 text-[15px] leading-relaxed text-neutral-700">
          <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-full bg-ink text-xs font-semibold text-white">{i + 1}</span>
          <span>{s}</span>
        </li>
      ))}
    </ol>
  );
}
