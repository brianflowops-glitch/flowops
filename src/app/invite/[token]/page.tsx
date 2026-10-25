import { Suspense } from "react";
import type { Metadata } from "next";
import { InviteAccept } from "@/components/auth/invite-accept";

export const metadata: Metadata = { title: "Team invitation", referrer: "no-referrer" };

export default function Page() {
  return (
    <Suspense>
      <InviteAccept />
    </Suspense>
  );
}
