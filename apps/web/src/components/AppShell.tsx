"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { ApiError, authApi, ModuleMenuItem, moduleUrl, modulesApi, Principal, ROLE_NAMES, sessionClock } from "@/lib/api";
import { SessionTimer, SessionWarning } from "./SessionWarning";
import { Icon, IconName, LogoTile } from "./icons";
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

/** Header for pages outside the signed-in shell (sign-in, setup, recovery, activation). */
export function BrandHeader({ title, children }: { title?: string; children?: React.ReactNode }) {
  return (
    <header>
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-4 pt-8 pb-2 sm:px-6">
        <Link href="/home/" className="flex items-center gap-3">
          <LogoTile size="h-12 w-12" />
          <span>
            <span className="block text-2xl font-extrabold tracking-tight text-ink">
              Nx<span className="text-brand">Gen</span>
            </span>
            <span className="block text-sm text-muted">Compliance platform for regulated laboratories</span>
          </span>
        </Link>
        {title && <p className="hidden text-right text-sm text-muted sm:block">{title}</p>}
        {children}
      </div>
    </header>
  );
}

type NavItem = { href: string; label: string; icon: IconName; permission: string | string[] | null; group: "work" | "admin" };

const NAV: NavItem[] = [
  { href: "/home/", label: "Home", icon: "home", permission: null, group: "work" },
  { href: "/tasks/", label: "My Tasks", icon: "tasks", permission: ["methods.review", "methods.approve", "calibration.approve"], group: "work" },
  { href: "/devices/", label: "Instruments", icon: "instrument", permission: "devices.view", group: "work" },
  { href: "/methods/", label: "Methods", icon: "method", permission: "methods.view", group: "work" },
  { href: "/users/", label: "Users", icon: "users", permission: "users.view", group: "admin" },
  { href: "/roles/", label: "Roles", icon: "roles", permission: "users.view", group: "admin" },
  { href: "/audit/", label: "Audit Trail", icon: "audit", permission: "audit.view", group: "admin" },
  { href: "/security/", label: "Security", icon: "security", permission: "audit.view", group: "admin" },
  { href: "/settings/modules/", label: "Modules", icon: "modules", permission: "modules.manage", group: "admin" },
  { href: "/system/", label: "System Information", icon: "system", permission: "system.view", group: "admin" },
];

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");

function NavLink({ href, label, icon, active, external, onClick }: { href: string; label: string; icon: IconName; active?: boolean; external?: boolean; onClick?: () => void }) {
  const cls = `group flex items-center gap-3 rounded-xl px-3.5 py-2.5 text-[15px] font-semibold transition-colors ${
    active ? "bg-brand-50 text-brand shadow-[inset_0_0_0_1px_rgb(37_99_235/0.08)]" : "text-ink/75 hover:bg-canvas hover:text-ink"
  }`;
  const inner = (
    <>
      <span className={active ? "text-brand" : "text-muted group-hover:text-ink"}>
        <Icon name={icon} />
      </span>
      {label}
    </>
  );
  return external ? (
    <a href={href} className={cls} onClick={onClick}>
      {inner}
    </a>
  ) : (
    <Link href={href} aria-current={active ? "page" : undefined} className={cls} onClick={onClick}>
      {inner}
    </Link>
  );
}

/** Layout for signed-in pages: sidebar navigation, page header with the signed-in user, and content. */
export function AppShell({ children, title }: { children: React.ReactNode; title: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const redirect = useAuthRedirect();
  const [principal, setPrincipal] = useState<Principal | null>(null);
  const [moduleMenu, setModuleMenu] = useState<ModuleMenuItem[]>([]);
  const [drawer, setDrawer] = useState(false);

  useEffect(() => {
    authApi
      .me()
      .then((p) => {
        if (p.mustChangePassword && pathname !== "/change-password/") router.replace("/change-password/?required=1");
        setPrincipal(p);
        if (!p.mustChangePassword) modulesApi.menu().then(setModuleMenu).catch(() => undefined);
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
      <div className="flex min-h-screen items-center justify-center gap-3 text-muted">
        <LogoTile size="h-9 w-9" />
        <StatusIcon tone="progress" /> <span>Checking your session…</span>
      </div>
    );
  }

  const allowed = NAV.filter((n) => !n.permission || [n.permission].flat().some((perm) => principal.permissions.includes(perm)));
  const current = allowed.find((n) => pathname.startsWith(n.href));
  const roleNames = principal.roles.map((r) => ROLE_NAMES[r] ?? r).join(", ");

  const sidebar = (
    <div className="flex h-full flex-col">
      <Link href="/home/" className="flex items-center gap-3 px-5 pt-6 pb-5">
        <LogoTile />
        <span className="leading-tight">
          <span className="block text-lg font-extrabold tracking-tight text-ink">
            Nx<span className="text-brand">Gen</span>
          </span>
          <span className="block text-[13px] font-semibold text-muted">Compliance Platform</span>
        </span>
      </Link>
      <nav aria-label="Main" className="flex-1 space-y-5 overflow-y-auto px-3 pb-4">
        {(["work", "admin"] as const).map((group) => {
          const items = allowed.filter((n) => n.group === group);
          if (!items.length && !(group === "work" && moduleMenu.length)) return null;
          return (
            <div key={group} className="space-y-1">
              <p className="px-3.5 pb-1 text-[11px] font-bold uppercase tracking-[0.14em] text-muted/70">
                {group === "work" ? "Laboratory" : "Administration"}
              </p>
              {items.map((n) => (
                <NavLink key={n.href} {...n} active={current?.href === n.href} onClick={() => setDrawer(false)} />
              ))}
              {group === "work" &&
                moduleMenu.map((m) => <NavLink key={m.href} href={moduleUrl(m.href)} label={m.label} icon="module" external />)}
            </div>
          );
        })}
      </nav>
      <div className="space-y-1 border-t border-line px-3 py-4 text-sm">
        <SessionTimer className="block px-3.5 py-1.5" />
        <p className="flex items-center gap-2.5 px-3.5 py-1.5 text-muted">
          <span className="h-2 w-2 rounded-full bg-pass shadow-[0_0_0_3px_rgb(19_150_90/0.15)]" aria-hidden />
          Connected
        </p>
        <button
          onClick={() => void signOut()}
          className="flex w-full items-center gap-2.5 rounded-xl px-3.5 py-2 font-semibold text-muted hover:bg-canvas hover:text-ink"
        >
          <Icon name="signout" className="h-[18px] w-[18px]" /> Sign out
        </button>
      </div>
    </div>
  );

  return (
    <SessionContext.Provider value={principal}>
      <div className="min-h-screen lg:flex">
        <aside className="sticky top-0 hidden h-screen w-[17rem] shrink-0 border-r border-line/80 bg-white/85 backdrop-blur lg:block">{sidebar}</aside>

        {drawer && (
          <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true" aria-label="Navigation">
            <button className="absolute inset-0 bg-navy/30 backdrop-blur-[2px]" aria-label="Close navigation" onClick={() => setDrawer(false)} />
            <aside className="relative h-full w-[17rem] bg-white shadow-xl">{sidebar}</aside>
          </div>
        )}

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex flex-wrap items-center justify-between gap-4 px-4 pt-6 pb-2 sm:px-8 lg:pt-8">
            <div className="flex items-center gap-3">
              <button
                className="grid h-11 w-11 place-items-center rounded-xl border border-line bg-white text-ink lg:hidden"
                onClick={() => setDrawer(true)}
                aria-label="Open navigation"
              >
                <Icon name="menu" />
              </button>
              <div>
                <p className="text-[12px] font-bold uppercase tracking-[0.16em] text-muted">{current?.label ?? "NxGen"}</p>
                <h1 className="text-[28px] font-extrabold leading-tight tracking-tight text-ink">{title}</h1>
              </div>
            </div>
            <div className="flex items-center gap-3 rounded-2xl border border-line/70 bg-white/80 py-1.5 pr-4 pl-1.5 shadow-[var(--shadow-card)]">
              <span className="grid h-10 w-10 place-items-center rounded-full bg-gradient-to-br from-navy-700 to-navy text-sm font-bold text-white" aria-hidden>
                {initials(principal.fullName)}
              </span>
              <span className="leading-tight">
                <span className="block text-sm font-bold text-ink">{principal.fullName}</span>
                <span className="flex items-center gap-1.5 text-xs text-muted">
                  <span className="h-1.5 w-1.5 rounded-full bg-pass" aria-hidden />
                  {roleNames || principal.username}
                </span>
                <SessionTimer className="block text-xs lg:hidden" />
              </span>
            </div>
          </header>
          <main className="w-full max-w-[84rem] flex-1 px-4 py-6 sm:px-8">{children}</main>
          <footer className="px-4 pb-6 text-xs text-muted sm:px-8">
            NxGen Compliance Platform · sessions end after {principal.sessionIdleMinutes ?? 15} minutes of inactivity
          </footer>
        </div>
        <SessionWarning />
      </div>
    </SessionContext.Provider>
  );
}
