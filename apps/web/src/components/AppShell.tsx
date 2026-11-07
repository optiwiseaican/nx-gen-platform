"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { ApiError, authApi, Principal, ROLE_NAMES, sessionClock } from "@/lib/api";
import { SessionWarning } from "./SessionWarning";
import { StatusIcon } from "./ui";

const SessionContext = createContext<Principal | null>(null);
export const usePrincipal = () => useContext(SessionContext)!;

/** Sends the user to sign-in or password change when the API says so. */
export function useAuthRedirect() {
  const router = useRouter();
  const pathname = usePathname();
  return useCallback(
    (err: unknown): boolean => {
      if (err instanceof ApiError && err.status === 401) {
        router.replace(`/login/?next=${encodeURIComponent(pathname)}&reason=session`);
        return true;
      }
      if (err instanceof ApiError && err.body?.code === "NX-AUTH-PASSWORD-CHANGE") {
        router.replace("/change-password/?required=1");
        return true;
      }
      return false;
    },
    [router, pathname],
  );
}

export function BrandHeader({ title, children }: { title?: string; children?: React.ReactNode }) {
  return (
    <header className="bg-navy text-white">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-4 py-4 sm:px-6">
        <Link href="/home/" className="block">
          <p className="text-xl font-bold tracking-tight">
            Nx<span className="text-[#7fb0ff]">Gen</span>
          </p>
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-white/70">Compliance Platform</p>
        </Link>
        {title && <h1 className="text-lg font-semibold">{title}</h1>}
        {children}
      </div>
    </header>
  );
}

const NAV: { href: string; label: string; permission: string | string[] | null }[] = [
  { href: "/home/", label: "Home", permission: null },
  { href: "/tasks/", label: "My Tasks", permission: ["methods.review", "methods.approve"] },
  { href: "/methods/", label: "Methods", permission: "methods.view" },
  { href: "/users/", label: "Users", permission: "users.view" },
  { href: "/roles/", label: "Roles", permission: "users.view" },
  { href: "/audit/", label: "Audit Trail", permission: "audit.view" },
  { href: "/security/", label: "Security", permission: "audit.view" },
  { href: "/system/", label: "System Information", permission: "system.view" },
];

/** Layout for signed-in pages: loads the session, shows identity, nav and sign-out. */
export function AppShell({ children, title }: { children: React.ReactNode; title: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const redirect = useAuthRedirect();
  const [principal, setPrincipal] = useState<Principal | null>(null);

  useEffect(() => {
    authApi
      .me()
      .then((p) => {
        if (p.mustChangePassword && pathname !== "/change-password/") router.replace("/change-password/?required=1");
        setPrincipal(p);
      })
      .catch((err) => {
        if (!redirect(err)) router.replace("/login/");
      });
  }, [router, pathname, redirect]);

  async function signOut() {
    await authApi.logout().catch(() => undefined);
    sessionClock.clear();
    router.replace("/login/?reason=signed-out");
  }

  if (!principal) {
    return (
      <div className="flex min-h-screen items-center justify-center text-muted">
        <StatusIcon tone="progress" /> <span className="ml-2">Checking your session…</span>
      </div>
    );
  }

  return (
    <SessionContext.Provider value={principal}>
      <div className="flex min-h-screen flex-col">
        <BrandHeader>
          <div className="flex items-center gap-4 text-sm">
            <div className="text-right">
              <p className="font-semibold">{principal.fullName}</p>
              <p className="text-white/70">
                {principal.username} · {principal.roles.map((r) => ROLE_NAMES[r] ?? r).join(", ")}
              </p>
            </div>
            <button
              onClick={() => void signOut()}
              className="rounded-md border border-white/40 px-3 py-1.5 font-semibold hover:bg-white/10"
            >
              Sign out
            </button>
          </div>
        </BrandHeader>
        <nav className="border-b border-line bg-white" aria-label="Main">
          <ul className="mx-auto flex max-w-6xl gap-1 overflow-x-auto px-4 sm:px-6">
            {NAV.filter(
              (n) =>
                !n.permission ||
                [n.permission].flat().some((perm) => principal.permissions.includes(perm)),
            ).map((n) => (
              <li key={n.href}>
                <Link
                  href={n.href}
                  aria-current={pathname.startsWith(n.href) ? "page" : undefined}
                  className={`block border-b-2 px-3 py-3 text-sm font-semibold ${
                    pathname.startsWith(n.href) ? "border-brand text-brand" : "border-transparent text-muted hover:text-ink"
                  }`}
                >
                  {n.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 sm:px-6">
          <h1 className="mb-6 text-2xl font-semibold text-ink">{title}</h1>
          {children}
        </main>
        <footer className="border-t border-line bg-white px-6 py-3 text-xs text-muted">
          <div className="mx-auto flex max-w-6xl justify-between">
            <span>NxGen Compliance Platform</span>
            <span>
              Sessions end after {principal.sessionIdleMinutes ?? 15} minutes of inactivity.
            </span>
          </div>
        </footer>
        <SessionWarning />
      </div>
    </SessionContext.Provider>
  );
}
