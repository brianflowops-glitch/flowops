import type { Metadata } from "next";
import { IntegrationsPage } from "@/components/views/static-pages";

export const metadata: Metadata = { title: "Integrations" };

export default function Page() {
  return <IntegrationsPage />;
}
