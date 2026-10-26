import { Suspense } from "react";
import type { Metadata } from "next";
import { PublicBooking } from "@/components/public-booking";

export const metadata: Metadata = { title: "Book online" };

export default function Page() {
  return (
    <Suspense>
      <PublicBooking />
    </Suspense>
  );
}
