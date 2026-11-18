"use client";

import { LogoTile } from "./icons";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ActivationOutcome,
  ApiError,
  authApi,
  LicenseErrorInfo,
  licensingApi,
  LicensingStatus,
  SERVICE_UNAVAILABLE,
  VerificationCheck,
} from "@/lib/api";
import { ArrowRight, Badge, Button, Callout, FieldTable, StatusIcon, Tone } from "./ui";

type Screen = "activate" | "activating" | "complete";

const STEPS: { id: Screen; label: string }[] = [
  { id: "activate", label: "Activate NxGen" },
  { id: "activating", label: "Verifying" },
  { id: "complete", label: "Complete" },
];

/** Screen 2 labels (License PRD §18), shown before the server responds. */
const PENDING_CHECKS: VerificationCheck[] = [
  "Installation verified",
  "Platform Instance verified",
  "License verified",
  "Commercial entitlement verified",
  "Platform license authorized",
  "Platform binding verified",
  "License stored securely",
  "Finalizing activation",
].map((label, i) => ({ id: String(i), label, status: "NOT_RUN" }));

const STEP_REVEAL_MS = 320;

const INPUT_ERRORS = {
  EMPTY: "Enter your NxGen License / Activation Code.",
  FORMAT: "Activation codes look like NXG-XXXX-XXXX-XXXX.",
  CHECKSUM: "This activation code is not valid. Check it for typing errors.",
} as const;

/** Uppercases and groups input as NXG-XXXX-XXXX-XXXX while typing. */
function formatCodeInput(value: string): string {
  const raw = value.toUpperCase().replace(/[^0-9A-Z]/g, "");
  if (raw.length <= 3 && "NXG".startsWith(raw)) return raw;
  const body = (raw.startsWith("NXG") ? raw.slice(3) : raw).slice(0, 12);
  const groups = body.match(/.{1,4}/g) ?? [];
  return ["NXG", ...groups].join("-");
}

export function ActivationWizard() {
  const router = useRouter();
  const [screen, setScreen] = useState<Screen>("activate");
  const [status, setStatus] = useState<LicensingStatus | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [code, setCode] = useState("");
  const [inputError, setInputError] = useState<string | null>(null);
  const [packageRequired, setPackageRequired] = useState(false);
  const [licenseFile, setLicenseFile] = useState<{ name: string; text: string } | null>(null);
  const [checks, setChecks] = useState<VerificationCheck[]>(PENDING_CHECKS);
  const [revealed, setRevealed] = useState(0);
  const [failure, setFailure] = useState<{ code: string; info: LicenseErrorInfo } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const codeInput = useRef<HTMLInputElement>(null);

  const loadStatus = useCallback(async () => {
    try {
      const s = await licensingApi.status();
      setStatus(s);
      setLoadError(false);
      if (s.license.state === "ACTIVE") {
        // Once setup is complete, the activation summary is no longer the entry point.
        const setup = await authApi.setupStatus().catch(() => null);
        if (setup?.administratorExists) return router.replace("/home/");
        setScreen("complete");
      }
    } catch {
      setLoadError(true);
    }
  }, [router]);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  const installationPassed =
    status?.installation.verification === "PASS" || status?.installation.verification === "PASS_WITH_WARNING";

  async function runActivation(file = licenseFile) {
    setInputError(null);
    const trimmed = code.trim();
    if (!trimmed) return setInputError(INPUT_ERRORS.EMPTY);
    if (!/^NXG-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/.test(trimmed)) return setInputError(INPUT_ERRORS.FORMAT);

    setFailure(null);
    setChecks(PENDING_CHECKS);
    setRevealed(0);
    setScreen("activating");

    let outcome: ActivationOutcome;
    const started = Date.now();
    try {
      outcome = await licensingApi.activate({
        activationCode: trimmed,
        licenseFile: file?.text,
        licenseFileName: file?.name,
      });
    } catch (err) {
      setChecks(PENDING_CHECKS);
      setRevealed(0);
      // After the first administrator exists, (re)activation requires licensing.manage.
      if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
        setFailure({
          code: err.status === 401 ? "NX-AUTH-REQUIRED" : "NX-AUTH-FORBIDDEN",
          info: {
            title: "Administrator sign-in required",
            message: "Re-activating NxGen requires an administrator with licensing permission.",
            action: "Sign in as an IT or Super Administrator, then return to this screen.",
          },
        });
        return;
      }
      setFailure({ code: "NX-LIC-E010", info: SERVICE_UNAVAILABLE });
      return;
    }

    // Inline Screen 1 conditions: stay on Screen 1 (PRD §15–16).
    if (outcome.inputError) {
      setScreen("activate");
      return setInputError(INPUT_ERRORS[outcome.inputError]);
    }
    if (outcome.licensePackageRequired) {
      setScreen("activate");
      setPackageRequired(true);
      setLicenseFile(null);
      return;
    }

    // Reveal server results step by step so the user can follow what was checked.
    const results = outcome.checks.length ? outcome.checks : PENDING_CHECKS;
    setChecks(results);
    const stopAt = outcome.ok ? results.length : Math.max(1, results.findIndex((c) => c.status === "FAIL") + 1);
    const wait = Math.max(0, 400 - (Date.now() - started));
    for (let i = 1; i <= stopAt; i++) {
      await new Promise((r) => setTimeout(r, i === 1 ? wait + STEP_REVEAL_MS : STEP_REVEAL_MS));
      setRevealed(i);
    }

    if (outcome.ok) {
      await new Promise((r) => setTimeout(r, 450));
      await loadStatus();
      setScreen("complete");
    } else {
      setFailure({ code: outcome.errorCode ?? "NX-LIC-E010", info: outcome.error ?? SERVICE_UNAVAILABLE });
    }
  }

  function onFileSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    if (!f.name.toLowerCase().endsWith(".nxlic")) {
      setInputError("Select an NxGen license file (.nxlic).");
      return;
    }
    void f.text().then((text) => {
      const selected = { name: f.name, text };
      setLicenseFile(selected);
      setPackageRequired(false);
      void runActivation(selected);
    });
  }

  function returnToStart() {
    setScreen("activate");
    setFailure(null);
    void loadStatus();
    setTimeout(() => codeInput.current?.focus(), 0);
  }

  const progress =
    failure && revealed === 0 ? 0 : Math.round((revealed / checks.length) * 100);

  return (
    <div className="flex min-h-screen flex-col">
      <AppHeader screen={screen} />

      <main className="mx-auto flex w-full max-w-5xl flex-1 px-4 py-8 sm:px-6">
        <div className="flex w-full flex-col overflow-hidden rounded-lg border border-line bg-white shadow-sm md:flex-row">
          <SideNav screen={screen} />

          <section className="flex-1 p-6 sm:p-10" aria-live="polite">
            {loadError ? (
              <div className="space-y-4">
                <Callout tone="fail" title={SERVICE_UNAVAILABLE.title}>
                  <p>{SERVICE_UNAVAILABLE.message}</p>
                  <p className="mt-1 font-medium text-ink">{SERVICE_UNAVAILABLE.action}</p>
                </Callout>
                <Button variant="secondary" onClick={() => void loadStatus()}>
                  Try Again
                </Button>
              </div>
            ) : !status ? (
              <p className="flex items-center gap-2 text-muted">
                <StatusIcon tone="progress" /> Contacting the NxGen License Service…
              </p>
            ) : screen === "activate" ? (
              <ActivateScreen
                status={status}
                installationPassed={installationPassed}
                code={code}
                onCode={(v) => {
                  setCode(formatCodeInput(v));
                  setInputError(null);
                }}
                inputError={inputError}
                packageRequired={packageRequired}
                licenseFile={licenseFile}
                onSelectFile={() => fileInput.current?.click()}
                onSubmit={() => void runActivation()}
                codeInputRef={codeInput}
              />
            ) : screen === "activating" ? (
              <ActivatingScreen
                checks={checks}
                revealed={revealed}
                progress={progress}
                failure={failure}
                instanceId={status.platform.instanceId}
                onRetry={() => void runActivation()}
                onReturn={returnToStart}
                onSignIn={() => router.push("/login/?next=/")}
              />
            ) : (
              <CompleteScreen status={status} onContinue={() => router.push("/setup/")} />
            )}
            <input ref={fileInput} type="file" accept=".nxlic" className="hidden" onChange={onFileSelected} />
          </section>
        </div>
      </main>

      <footer className="border-t border-line bg-white px-6 py-3 text-xs text-muted">
        <div className="mx-auto flex max-w-5xl flex-wrap justify-between gap-2">
          <span>NxGen Compliance Platform | License &amp; Entitlement Service</span>
          <span>Secure. Offline. Compliant.</span>
        </div>
      </footer>
    </div>
  );
}

// ---------------------------------------------------------------------------

function AppHeader({ screen }: { screen: Screen }) {
  const index = STEPS.findIndex((s) => s.id === screen);
  return (
    <header>
      <div className="mx-auto flex max-w-5xl flex-col gap-4 px-4 pt-8 pb-2 sm:px-6 md:flex-row md:items-center md:justify-between">
        <div className="flex items-center gap-3">
          <LogoTile size="h-12 w-12" />
          <div>
            <p className="text-2xl font-extrabold tracking-tight text-ink">
              Nx<span className="text-brand">Gen</span>
            </p>
            <p className="text-sm text-muted">Platform activation · secure, offline</p>
          </div>
        </div>
        <ol className="flex items-center gap-2 text-sm" aria-label="Activation progress">
          {STEPS.map((s, i) => (
            <li key={s.id} className="flex items-center gap-2">
              <span
                className={`flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold ${
                  i <= index ? "bg-brand text-white shadow-[var(--shadow-brand)]" : "border border-line bg-white text-muted"
                }`}
                aria-current={i === index ? "step" : undefined}
              >
                {i < index ? "✓" : i + 1}
              </span>
              <span className={i === index ? "font-semibold text-ink" : "text-muted"}>{s.label}</span>
              {i < STEPS.length - 1 && <span className="mx-1 hidden h-px w-6 bg-line sm:block" />}
            </li>
          ))}
        </ol>
      </div>
    </header>
  );
}

function SideNav({ screen }: { screen: Screen }) {
  const index = STEPS.findIndex((s) => s.id === screen);
  return (
    <nav aria-label="Activation steps" className="border-b border-line bg-canvas/60 p-4 md:w-56 md:border-b-0 md:border-r md:p-6">
      <ol className="flex gap-4 md:flex-col md:gap-3">
        {STEPS.map((s, i) => {
          const tone: Tone = i < index ? "pass" : i === index ? "info" : "pending";
          return (
            <li key={s.id} className={`flex items-center gap-2.5 text-sm ${i === index ? "font-semibold text-ink" : "text-muted"}`}>
              {i < index ? (
                <StatusIcon tone="pass" />
              ) : (
                <span
                  className={`flex h-5 w-5 items-center justify-center rounded-full text-[11px] font-bold ${
                    tone === "info" ? "bg-brand text-white" : "border border-muted/50"
                  }`}
                >
                  {i + 1}
                </span>
              )}
              {s.label}
              <span className="sr-only">{i < index ? "(completed)" : i === index ? "(current)" : "(pending)"}</span>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

function ActivateScreen(props: {
  status: LicensingStatus;
  installationPassed: boolean;
  code: string;
  onCode: (v: string) => void;
  inputError: string | null;
  packageRequired: boolean;
  licenseFile: { name: string } | null;
  onSelectFile: () => void;
  onSubmit: () => void;
  codeInputRef: React.RefObject<HTMLInputElement | null>;
}) {
  const { status, installationPassed } = props;
  const license = status.license;
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-semibold text-ink">Welcome to NxGen</h2>
        <p className="mt-1 text-muted">Activate your NxGen Platform to continue setup.</p>
      </div>

      {license.error && license.state !== "NOT_ACTIVATED" && (
        <Callout tone={license.state === "ACTIVATION_ERROR" ? "fail" : "warn"} title={license.error.title}>
          <p>{license.error.message}</p>
          <p className="mt-1">
            <span className="font-mono text-xs">{license.errorCode}</span> — {license.error.action}
          </p>
          {license.restricted && (
            <p className="mt-1">Existing records remain available for viewing, review, backup and archive.</p>
          )}
        </Callout>
      )}

      <div className="rounded-lg border border-line">
        <div className="flex items-center justify-between gap-3 border-b border-line px-5 py-3">
          <h3 className="flex items-center gap-2 font-semibold">
            <StatusIcon tone={installationPassed ? "pass" : "fail"} />
            Installation Verification
          </h3>
          <div className="flex flex-wrap items-center justify-end gap-2">
            {status.installation.simulated && <Badge tone="warn">SIMULATED</Badge>}
            {installationPassed ? <Badge tone="pass">PASS</Badge> : <Badge tone="fail">NOT VERIFIED</Badge>}
          </div>
        </div>
        {status.installation.simulated && (
          <p className="border-b border-line bg-warn-50 px-5 py-2 text-sm text-warn">
            Development only: this installation record was created by <code>platform:init</code>, not by the NxGen
            Smart Installer.
          </p>
        )}
        <div className="px-5 py-2">
          <FieldTable
            rows={[
              ["Platform", status.platform.name],
              ["Platform Version", status.platform.version],
              ["Platform Instance ID", <span key="id" className="font-mono">{status.platform.instanceId ?? "—"}</span>],
              ["Environment", status.installation.environment],
              ["Installation Status", status.installation.status],
            ]}
          />
        </div>
      </div>

      {!installationPassed ? (
        <Callout tone="fail" title="Activation unavailable">
          Activation cannot continue because NxGen installation verification has not passed.
        </Callout>
      ) : (
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            props.onSubmit();
          }}
          noValidate
        >
          <div>
            <label htmlFor="activation-code" className="mb-1.5 block text-sm font-semibold text-ink">
              License / Activation Code
            </label>
            <input
              id="activation-code"
              ref={props.codeInputRef}
              value={props.code}
              onChange={(e) => props.onCode(e.target.value)}
              placeholder="NXG-XXXX-XXXX-XXXX"
              autoComplete="off"
              spellCheck={false}
              autoFocus
              maxLength={18}
              aria-invalid={!!props.inputError}
              aria-describedby={props.inputError ? "code-error" : "code-help"}
              className={`w-full rounded-md border bg-white px-4 py-3 font-mono text-lg tracking-wider placeholder:text-muted/50 ${
                props.inputError ? "border-fail" : "border-line"
              }`}
            />
            {props.inputError ? (
              <p id="code-error" className="mt-2 flex items-center gap-1.5 text-sm text-fail">
                <StatusIcon tone="fail" className="h-4 w-4" /> {props.inputError}
              </p>
            ) : (
              <p id="code-help" className="mt-2 text-sm text-muted">
                Make sure you have the valid NxGen activation code and the signed license package available on this computer.
              </p>
            )}
          </div>

          {props.packageRequired && (
            <Callout tone="warn" title="License Package Required">
              <p>The signed NxGen license package for this activation could not be found.</p>
              <Button type="button" variant="secondary" className="mt-3" onClick={props.onSelectFile}>
                Select License File
              </Button>
            </Callout>
          )}
          {props.licenseFile && !props.packageRequired && (
            <p className="text-sm text-muted">
              License file: <span className="font-medium text-ink">{props.licenseFile.name}</span>
            </p>
          )}

          <div className="flex justify-end">
            <Button type="submit">
              Verify &amp; Activate <ArrowRight />
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}

function ActivatingScreen(props: {
  checks: VerificationCheck[];
  revealed: number;
  progress: number;
  failure: { code: string; info: LicenseErrorInfo } | null;
  instanceId: string | null;
  onRetry: () => void;
  onReturn: () => void;
  onSignIn: () => void;
}) {
  const { checks, revealed, failure } = props;
  const signInNeeded = failure?.code === "NX-AUTH-REQUIRED" || failure?.code === "NX-AUTH-FORBIDDEN";
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-semibold text-ink">{failure ? "Activation Failed" : "Activating NxGen"}</h2>
        <p className="mt-1 text-muted">
          {failure
            ? "NxGen could not verify this license."
            : "Please wait while NxGen verifies your license and activates this platform."}
        </p>
      </div>

      <ol className="space-y-3">
        {checks.map((c, i) => {
          const shown = i < revealed;
          const tone: Tone = shown
            ? c.status === "FAIL"
              ? "fail"
              : c.status === "PASS"
                ? "pass"
                : "pending"
            : !failure && i === revealed
              ? "progress"
              : "pending";
          const word = { pass: "passed", fail: "failed", progress: "in progress", pending: "pending" }[tone as string];
          return (
            <li key={c.id} className={`flex items-center gap-3 ${tone === "pending" ? "text-muted" : "text-ink"}`}>
              <StatusIcon tone={tone} className="h-6 w-6" />
              <span className={tone === "fail" ? "font-semibold text-fail" : "font-medium"}>{c.label}</span>
              <span className="sr-only">({word})</span>
            </li>
          );
        })}
      </ol>

      {!failure && (
        <div>
          <div
            className="h-2 overflow-hidden rounded-full bg-line"
            role="progressbar"
            aria-valuenow={props.progress}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label="Activation progress"
          >
            <div className="h-full bg-brand transition-all duration-300" style={{ width: `${props.progress}%` }} />
          </div>
          <p className="mt-2 flex justify-between text-sm text-muted">
            <span>This may take a few moments.</span>
            <span>{props.progress}%</span>
          </p>
        </div>
      )}

      {failure && (
        <div className="space-y-4">
          <Callout tone="fail" title={failure.info.title}>
            <p>
              Error: <span className="font-mono text-xs font-semibold text-ink">{failure.code}</span>
            </p>
            <p className="mt-1">{failure.info.message}</p>
            {failure.code === "NX-LIC-E006" && props.instanceId && (
              <p className="mt-1">
                Current Platform: <span className="font-mono font-medium text-ink">{props.instanceId}</span>
              </p>
            )}
            <p className="mt-2 font-medium text-ink">{failure.info.action}</p>
          </Callout>
          <div className="flex flex-wrap justify-end gap-3">
            <Button variant="secondary" onClick={props.onReturn}>
              Return
            </Button>
            {signInNeeded ? (
              <Button onClick={props.onSignIn}>Sign In</Button>
            ) : (
              <Button onClick={props.onRetry}>Try Again</Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function CompleteScreen({ status, onContinue }: { status: LicensingStatus; onContinue: () => void }) {
  return (
    <div className="mx-auto max-w-lg space-y-6 text-center">
      <StatusIcon tone="pass" className="mx-auto h-20 w-20" />
      <div>
        <h2 className="text-2xl font-semibold text-ink">NxGen Activated</h2>
        <p className="mt-1 text-muted">Your NxGen Platform has been successfully activated.</p>
      </div>
      <div className="rounded-lg border border-line px-5 py-2 text-left">
        <FieldTable
          rows={[
            ["Platform", status.platform.name],
            ["License Status", <span key="l" className="font-semibold text-pass">✓ ACTIVE</span>],
            ["Installation", <span key="i" className="font-semibold text-pass">✓ VERIFIED</span>],
            ["Platform Instance ID", <span key="p" className="font-mono">{status.platform.instanceId}</span>],
          ]}
        />
      </div>
      <div className="text-left">
        <Callout tone="pass" title="NxGen is now activated.">
          You can continue with administrator setup, security configuration and other system settings.
        </Callout>
      </div>
      <div className="space-y-3">
        <Button className="w-full" onClick={onContinue} autoFocus>
          Continue Setup <ArrowRight />
        </Button>
        <Link href="/system/" className="inline-block text-sm font-semibold text-brand hover:underline">
          View System Information
        </Link>
      </div>
    </div>
  );
}
