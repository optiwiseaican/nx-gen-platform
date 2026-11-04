"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { loadSignaturePolicy, ReasonDialog, SignatureManifest } from "@/components/admin";
import { AppShell, useAuthRedirect, usePrincipal } from "@/components/AppShell";
import { Badge, Button, Callout, FieldTable, StatusIcon } from "@/components/ui";
import {
  authApi,
  SetupStatus,
  SignatureInput,
  SignatureMeaning,
  SignaturePolicy,
  SignatureRecord,
  signaturesApi,
} from "@/lib/api";

function Security() {
  const principal = usePrincipal();
  const redirect = useAuthRedirect();
  const canEdit = principal.permissions.includes("security.manage");
  const [policies, setPolicies] = useState<SignaturePolicy[] | null>(null);
  const [meanings, setMeanings] = useState<SignatureMeaning[]>([]);
  const [draft, setDraft] = useState<Record<string, { required: boolean; defaultMeaning: string }>>({});
  const [account, setAccount] = useState<SetupStatus["passwordPolicy"] | null>(null);
  const [recent, setRecent] = useState<SignatureRecord[]>([]);
  const [confirming, setConfirming] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [p, s, sigs] = await Promise.all([loadSignaturePolicy(true), authApi.setupStatus(), signaturesApi.list()]);
      setPolicies(p.policies);
      setMeanings(p.meanings);
      setDraft(Object.fromEntries(p.policies.map((x) => [x.actionCode, { required: x.required, defaultMeaning: x.defaultMeaning }])));
      setAccount(s.passwordPolicy);
      setRecent(sigs.slice(0, 10));
    } catch (err) {
      if (!redirect(err)) setError(err instanceof Error ? err.message : "Could not load security settings.");
    }
  }, [redirect]);

  useEffect(() => {
    void load();
  }, [load]);

  const changes = useMemo(
    () =>
      (policies ?? [])
        .filter((p) => draft[p.actionCode] && (draft[p.actionCode].required !== p.required || draft[p.actionCode].defaultMeaning !== p.defaultMeaning))
        .map((p) => ({ actionCode: p.actionCode, ...draft[p.actionCode] })),
    [policies, draft],
  );

  async function save(reason: string, signature?: SignatureInput) {
    await signaturesApi.updatePolicy(changes, reason, signature);
    setConfirming(false);
    setNotice("Signature requirements updated. The change was signed and recorded.");
    await load();
  }

  if (error) return <Callout tone="fail">{error}</Callout>;
  if (!policies || !account) {
    return (
      <p className="flex items-center gap-2 text-muted">
        <StatusIcon tone="progress" /> Loading…
      </p>
    );
  }

  return (
    <div className="space-y-8">
      {notice && <Callout tone="pass">{notice}</Callout>}

      <section className="rounded-lg border border-line bg-white">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-3">
          <div>
            <h2 className="font-semibold">Electronic signature requirements</h2>
            <p className="text-sm text-muted">
              Signing requires the user&apos;s own username and password every time, and a stated meaning (21 CFR 11.50, 11.200).
            </p>
          </div>
          {canEdit && (
            <Button onClick={() => setConfirming(true)} disabled={changes.length === 0}>
              Save changes…
            </Button>
          )}
        </div>
        <table className="w-full text-left text-sm">
          <thead className="border-b border-line bg-canvas text-xs uppercase tracking-wide text-muted">
            <tr>
              <th className="px-5 py-3">Action</th>
              <th className="px-5 py-3">Signature</th>
              <th className="px-5 py-3">Default meaning</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {policies.map((p) => {
              const d = draft[p.actionCode];
              const changed = d && (d.required !== p.required || d.defaultMeaning !== p.defaultMeaning);
              return (
                <tr key={p.actionCode} className={changed ? "bg-warn-50" : ""}>
                  <td className="px-5 py-3">
                    <p className="font-medium text-ink">{p.description}</p>
                    <p className="font-mono text-xs text-muted">{p.actionCode}</p>
                  </td>
                  <td className="px-5 py-3">
                    {p.locked ? (
                      <Badge tone="pass">ALWAYS REQUIRED</Badge>
                    ) : canEdit ? (
                      <label className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={d?.required ?? p.required}
                          onChange={(e) => setDraft({ ...draft, [p.actionCode]: { ...d, required: e.target.checked } })}
                        />
                        {d?.required ? "Required" : "Optional"}
                      </label>
                    ) : p.required ? (
                      <Badge tone="pass">REQUIRED</Badge>
                    ) : (
                      <span className="text-muted">Optional</span>
                    )}
                  </td>
                  <td className="px-5 py-3">
                    {canEdit ? (
                      <select
                        aria-label={`Default meaning for ${p.description}`}
                        value={d?.defaultMeaning ?? p.defaultMeaning}
                        onChange={(e) => setDraft({ ...draft, [p.actionCode]: { ...d, defaultMeaning: e.target.value } })}
                        className="rounded-md border border-line bg-white px-2 py-1"
                      >
                        {meanings.map((m) => (
                          <option key={m.code} value={m.code}>
                            {m.label}
                          </option>
                        ))}
                      </select>
                    ) : (
                      meanings.find((m) => m.code === p.defaultMeaning)?.label
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      <div className="grid gap-6 lg:grid-cols-2">
        <section className="rounded-lg border border-line bg-white">
          <h2 className="border-b border-line px-5 py-3 font-semibold">Account &amp; session controls</h2>
          <div className="px-5 py-2">
            <FieldTable
              rows={[
                ["Minimum password length", `${account.minLength} characters, 3 of 4 character types`],
                ["Password expiry", `${account.maxAgeDays} days`],
                ["Password history", `Last ${account.history} cannot be reused`],
                ["Lockout", `After ${account.maxFailedLogins} failed sign-in or signature attempts, for ${account.lockoutMinutes} minutes`],
                ["Inactivity sign-out", `${account.sessionIdleMinutes} minutes`],
                ["Maximum session", `${account.sessionMaxHours} hours`],
              ]}
            />
            <p className="py-2 text-xs text-muted">Configured at installation per site SOP.</p>
          </div>
        </section>

        <section className="rounded-lg border border-line bg-white">
          <h2 className="border-b border-line px-5 py-3 font-semibold">Signature meanings</h2>
          <ul className="divide-y divide-line text-sm">
            {meanings.map((m) => (
              <li key={m.code} className="px-5 py-2.5">
                <span className="font-semibold text-ink">{m.label}</span> — <span className="text-muted">“{m.statement}”</span>
              </li>
            ))}
          </ul>
        </section>
      </div>

      <section className="space-y-3">
        <h2 className="font-semibold">Recent electronic signatures</h2>
        {recent.map((sig) => (
          <SignatureManifest key={sig.id} sig={sig} />
        ))}
        {recent.length === 0 && <p className="text-sm text-muted">No signatures yet.</p>}
      </section>

      <ReasonDialog
        open={confirming}
        title="Change signature requirements"
        description={
          <ul className="list-disc pl-5">
            {changes.map((c) => (
              <li key={c.actionCode}>
                {policies.find((p) => p.actionCode === c.actionCode)?.description}: {c.required ? "required" : "optional"}, default{" "}
                {meanings.find((m) => m.code === c.defaultMeaning)?.label}
              </li>
            ))}
          </ul>
        }
        confirmLabel="Save"
        action="SIGNATURE_POLICY_CHANGE"
        onConfirm={save}
        onClose={() => setConfirming(false)}
      />
    </div>
  );
}

export default function SecurityPage() {
  return (
    <AppShell title="Security">
      <Security />
    </AppShell>
  );
}
