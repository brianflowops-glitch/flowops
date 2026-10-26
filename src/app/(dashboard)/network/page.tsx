import type { Metadata } from "next";
import { NetworkOperations } from "@/components/views/static-pages";

export const metadata: Metadata = { title: "Network Operations" };

export default function Page() {
  return <NetworkOperations />;
}
