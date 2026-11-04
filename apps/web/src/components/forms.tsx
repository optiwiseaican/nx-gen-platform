import type { InputHTMLAttributes } from "react";
import { StatusIcon } from "./ui";

export function TextField({
  label,
  error,
  hint,
  id,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { label: string; id: string; error?: string | null; hint?: string }) {
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-sm font-semibold text-ink">
        {label}
      </label>
      <input
        id={id}
        {...props}
        aria-invalid={!!error}
        aria-describedby={error ? `${id}-error` : hint ? `${id}-hint` : undefined}
        className={`w-full rounded-md border bg-white px-3.5 py-2.5 text-[15px] ${error ? "border-fail" : "border-line"}`}
      />
      {error ? (
        <p id={`${id}-error`} className="mt-1.5 flex items-start gap-1.5 text-sm text-fail">
          <StatusIcon tone="fail" className="mt-0.5 h-4 w-4" /> {error}
        </p>
      ) : (
        hint && (
          <p id={`${id}-hint`} className="mt-1.5 text-sm text-muted">
            {hint}
          </p>
        )
      )}
    </div>
  );
}

/** Live password rule checklist (mirrors the server policy; the server remains authoritative). */
export function PasswordRules({
  password,
  minLength,
  username,
  fullName,
}: {
  password: string;
  minLength: number;
  username?: string;
  fullName?: string;
}) {
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(password)).length;
  const lower = password.toLowerCase();
  const nameParts = (fullName ?? "").toLowerCase().split(/\s+/).filter((p) => p.length >= 4);
  const rules = [
    { ok: password.length >= minLength, text: `At least ${minLength} characters` },
    { ok: classes >= 3, text: "Three of: lowercase, uppercase, digits, symbols" },
    { ok: !username || username.length < 3 || !lower.includes(username.toLowerCase()), text: "Does not contain the username" },
    { ok: !nameParts.some((p) => lower.includes(p)), text: "Does not contain your name" },
  ];
  return (
    <ul className="mt-2 grid gap-1 text-sm sm:grid-cols-2" aria-label="Password requirements">
      {rules.map((r) => (
        <li key={r.text} className={`flex items-center gap-1.5 ${r.ok && password ? "text-pass" : "text-muted"}`}>
          <StatusIcon tone={r.ok && password ? "pass" : "pending"} className="h-4 w-4" />
          {r.text}
          <span className="sr-only">{r.ok && password ? "(met)" : "(not met)"}</span>
        </li>
      ))}
    </ul>
  );
}
