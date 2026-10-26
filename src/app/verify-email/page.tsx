import { Suspense } from "react";
import type { Metadata } from "next";
import { VerifyEmailView } from "@/components/auth/password-reset";

export const metadata: Metadata = { title: "Verify email" };

export default function Page() {
  return (
    <Suspense>
      <VerifyEmailView />
    </Suspense>
  );
}
