import type { Metadata } from "next";
import { SecurityCenter } from "@/components/views/static-pages";

export const metadata: Metadata = { title: "Security Center" };

export default function Page() {
  return <SecurityCenter />;
}
