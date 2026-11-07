"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ReasonDialog } from "@/components/admin";
import { AppShell, useAuthRedirect } from "@/components/AppShell";
import { DeviceForm, DeviceFormValues } from "@/components/devices";
import { Callout } from "@/components/ui";
import { devicesApi, InstrumentTypeInfo, SignatureInput } from "@/lib/api";

const EMPTY: DeviceFormValues = {
  instrumentType: "",
  name: "",
  manufacturer: "",
  model: "",
  serialNumber: "",
  assetTag: "",
  location: "",
  firmwareVersion: "",
  deviceIdentifier: "",
  installedOn: "",
  calibrationIntervalDays: 30,
  calibrationWarningDays: 7,
};

function NewDevice() {
  const router = useRouter();
  const redirect = useAuthRedirect();
  const [values, setValues] = useState<DeviceFormValues | null>(null);
  const [types, setTypes] = useState<InstrumentTypeInfo[] | null>(null);

  useEffect(() => {
    devicesApi
      .types()
      .then(setTypes)
      .catch((err) => redirect(err));
  }, [redirect]);

  async function register(reason: string, signature?: SignatureInput) {
    const d = await devicesApi.register({ ...values!, installedOn: values!.installedOn || null, reason, signature });
    router.push(`/devices/view/?id=${d.id}`);
  }

  return (
    <div className="max-w-4xl space-y-4">
      <p className="text-sm text-muted">
        A new instrument is blocked from use until its first calibration is approved.
      </p>
      {types && types.some((t) => !t.available) && (
        <Callout tone="info">
          Instrument types marked “module not installed” become available when their NxGen module is installed under Modules.
        </Callout>
      )}
      {types && (
        <DeviceForm
          initial={{ ...EMPTY, instrumentType: types.find((t) => t.available)?.code ?? "OTHER" }}
          types={types}
          submitLabel="Register…"
          onSubmit={setValues}
          onCancel={() => router.push("/devices/")}
        />
      )}
      <ReasonDialog
        open={!!values}
        title="Register instrument"
        description={
          values
            ? `${types?.find((t) => t.code === values.instrumentType)?.label ?? values.instrumentType}: ${values.name}, ${values.manufacturer} ${values.model}, serial ${values.serialNumber}.`
            : ""
        }
        confirmLabel="Register"
        action="DEVICE_REGISTER"
        reasonPlaceholder="e.g. New pH meter for QC lab 2, PO-2026-311"
        onConfirm={register}
        onClose={() => setValues(null)}
      />
    </div>
  );
}

export default function NewDevicePage() {
  return (
    <AppShell title="Register Instrument">
      <NewDevice />
    </AppShell>
  );
}
