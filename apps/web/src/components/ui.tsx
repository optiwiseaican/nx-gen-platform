import type { ReactNode } from "react";

/** Status is always icon + text, never colour alone (Smart Installer PRD §69, License PRD §47). */
export type Tone = "pass" | "warn" | "fail" | "info" | "pending" | "progress";

const TONE_TEXT: Record<Tone, string> = {
  pass: "text-pass",
  warn: "text-warn",
  fail: "text-fail",
  info: "text-brand",
  pending: "text-muted",
  progress: "text-brand",
};

export function StatusIcon({ tone, className = "h-5 w-5" }: { tone: Tone; className?: string }) {
  const common = { className: `${className} shrink-0 ${TONE_TEXT[tone]}`, "aria-hidden": true, viewBox: "0 0 24 24" };
  switch (tone) {
    case "pass":
      return (
        <svg {...common} fill="currentColor">
          <circle cx="12" cy="12" r="11" />
          <path d="M7 12.5l3.2 3.2L17.5 8.4" fill="none" stroke="white" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case "fail":
      return (
        <svg {...common} fill="currentColor">
          <circle cx="12" cy="12" r="11" />
          <path d="M8.5 8.5l7 7M15.5 8.5l-7 7" stroke="white" strokeWidth="2.4" strokeLinecap="round" />
        </svg>
      );
    case "warn":
      return (
        <svg {...common} fill="currentColor">
          <path d="M12 2.5L23 21.5H1L12 2.5z" />
          <path d="M12 9v5.5M12 17.6v.4" stroke="white" strokeWidth="2.2" strokeLinecap="round" />
        </svg>
      );
    case "info":
      return (
        <svg {...common} fill="currentColor">
          <circle cx="12" cy="12" r="11" />
          <path d="M12 11v6M12 7.4v.4" stroke="white" strokeWidth="2.2" strokeLinecap="round" />
        </svg>
      );
    case "progress":
      return (
        <svg {...common} fill="none" className={`${common.className} animate-spin`}>
          <circle cx="12" cy="12" r="9.5" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
          <path d="M21.5 12A9.5 9.5 0 0 0 12 2.5" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
        </svg>
      );
    default:
      return (
        <svg {...common} fill="none">
          <circle cx="12" cy="12" r="9.5" stroke="currentColor" strokeWidth="2" />
        </svg>
      );
  }
}

export function Badge({ tone, children }: { tone: "pass" | "warn" | "fail"; children: ReactNode }) {
  const styles = {
    pass: "border-pass/30 bg-pass-50 text-pass",
    warn: "border-warn/30 bg-warn-50 text-warn",
    fail: "border-fail/30 bg-fail-50 text-fail",
  }[tone];
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-bold tracking-wide ${styles}`}>
      <StatusIcon tone={tone} className="h-3.5 w-3.5" />
      {children}
    </span>
  );
}

export function Callout({ tone, title, children }: { tone: "info" | "warn" | "fail" | "pass"; title?: string; children: ReactNode }) {
  const styles = {
    info: "border-brand/25 bg-brand-50",
    warn: "border-warn/30 bg-warn-50",
    fail: "border-fail/30 bg-fail-50",
    pass: "border-pass/30 bg-pass-50",
  }[tone];
  return (
    <div className={`flex gap-3 rounded-xl border p-4 text-sm ${styles}`} role={tone === "fail" ? "alert" : undefined}>
      <StatusIcon tone={tone} />
      <div className="space-y-1">
        {title && <p className="font-semibold text-ink">{title}</p>}
        <div className="text-muted">{children}</div>
      </div>
    </div>
  );
}

export function Button({
  variant = "primary",
  className = "",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" }) {
  const styles =
    variant === "primary"
      ? "bg-brand text-white shadow-[var(--shadow-brand)] hover:bg-brand-700 disabled:bg-brand/40 disabled:shadow-none"
      : "border border-line bg-white text-ink shadow-[0_1px_2px_rgb(15_27_51/0.05)] hover:border-brand/30 hover:bg-brand-50/40 disabled:text-muted";
  return (
    <button
      {...props}
      className={`inline-flex min-h-11 items-center justify-center gap-2 rounded-xl px-5 text-[15px] font-semibold transition-all active:translate-y-px disabled:cursor-not-allowed ${styles} ${className}`}
    />
  );
}

export function FieldTable({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="divide-y divide-line text-sm">
      {rows.map(([label, value]) => (
        <div key={label} className="grid grid-cols-[minmax(0,11rem)_1fr] gap-4 py-2.5">
          <dt className="text-muted">{label}</dt>
          <dd className="font-medium text-ink">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function ArrowRight() {
  return (
    <svg aria-hidden viewBox="0 0 20 20" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M4 10h12M11 5l5 5-5 5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
