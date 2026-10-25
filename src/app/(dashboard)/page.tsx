import type { Metadata } from "next";
import { CommandCenter } from "@/components/views/command-center";

export const metadata: Metadata = { title: "Command Center" };

export default function Page() {
  return <CommandCenter />;
}
