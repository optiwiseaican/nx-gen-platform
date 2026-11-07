"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { ReasonDialog } from "@/components/admin";
import { AppShell } from "@/components/AppShell";
import { DeviceForm, DeviceFormValues } from "@/components/devices";
import { devicesApi, INSTRUMENT_LABELS, SignatureInput } from "@/lib/api";

const EMPTY: DeviceFormValues = {
  instrumentType: "PH",
  name: "",
  manufacturer: "",
  model: "",
  serialNumber: "",
  assetTag: "",
  location: "",
  firmwareVersion: "",
  installedOn: "",
  calibrationIntervalDays: 30,
  calibrationWarningDays: 7,
};

function NewDevice() {
  const router = useRouter();
  const [values, setValues] = useState<DeviceFormValues | null>(null);

  async function register(reason: string, signature?: SignatureInput) {
    const d = await devicesApi.register({ ...values!, installedOn: values!.installedOn || null, reason, signature });
    router.push(`/devices/view/?id=${d.id}`);
  }

  return (
    <div className="max-w-4xl space-y-4">
      <p className="text-sm text-muted">
        A new instrument is blocked from use until its first calibration is approved.
      </p>
      <DeviceForm initial={EMPTY} submitLabel="Register…" onSubmit={setValues} onCancel={() => router.push("/devices/")} />
      <ReasonDialog
        open={!!values}
        title="Register instrument"
        description={values ? `${INSTRUMENT_LABELS[values.instrumentType]} ${values.name}, ${values.manufacturer} ${values.model}, serial ${values.serialNumber}.` : ""}
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
