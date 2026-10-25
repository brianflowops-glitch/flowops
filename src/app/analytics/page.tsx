import type { Metadata } from "next";
import { Analytics } from "@/components/views/analytics";

export const metadata: Metadata = { title: "Analytics" };

export default function Page() {
  return <Analytics />;
}
