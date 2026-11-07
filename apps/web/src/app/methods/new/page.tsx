"use client";

import { useRouter } from "next/navigation";
import { AppShell } from "@/components/AppShell";
import { MethodForm } from "@/components/MethodForm";
import { methodsApi } from "@/lib/api";

function NewMethod() {
  const router = useRouter();
  return (
    <div className="max-w-4xl space-y-4">
      <p className="text-sm text-muted">
        The method is saved as a draft (version 1). You can keep editing it until you submit it for review.
      </p>
      <MethodForm
        initial={{ instrumentType: "PH", name: "", purpose: "", procedure: "", parameters: [{ name: "", value: "", unit: "" }], changeSummary: "" }}
        submitLabel="Save draft"
        onSubmit={async (values) => {
          const m = await methodsApi.create(values);
          router.push(`/methods/view/?id=${m.id}`);
        }}
        onCancel={() => router.push("/methods/")}
      />
    </div>
  );
}

export default function NewMethodPage() {
  return (
    <AppShell title="New Method">
      <NewMethod />
    </AppShell>
  );
}
