import type { Metadata } from "next";
import { AgentMatrix } from "@/components/views/agent-matrix";

export const metadata: Metadata = { title: "Agent Matrix" };

export default function Page() {
  return <AgentMatrix />;
}
