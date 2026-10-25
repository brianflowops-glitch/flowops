import type { Metadata } from "next";
import { AutomationCenter } from "@/components/views/static-pages";

export const metadata: Metadata = { title: "Automation Center" };

export default function Page() {
  return <AutomationCenter />;
}
