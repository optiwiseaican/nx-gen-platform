import Link from "next/link";

/** Placeholder: Administrator Setup belongs to its own PRD (License PRD §30). */
export default function SetupPage() {
  return (
    <main className="mx-auto max-w-2xl px-6 py-16">
      <p className="text-sm font-semibold uppercase tracking-widest text-brand">Next stage</p>
      <h1 className="mt-2 text-2xl font-semibold text-ink">Administrator Setup</h1>
      <p className="mt-3 text-muted">
        NxGen is activated. Administrator setup, security configuration, module configuration, device configuration
        and qualification are separate stages and have not been built yet.
      </p>
      <p className="mt-6 rounded-md border border-line bg-white p-4 text-sm text-muted">
        System status: <span className="font-semibold text-ink">QUALIFICATION REQUIRED</span> — NxGen is not released for
        production laboratory use.
      </p>
      <Link href="/" className="mt-8 inline-block text-sm font-semibold text-brand hover:underline">
        ← Back to activation status
      </Link>
    </main>
  );
}
