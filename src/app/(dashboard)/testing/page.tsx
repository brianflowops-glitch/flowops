import type { Metadata } from "next";
import { TestingLab } from "@/components/views/testing-lab";

export const metadata: Metadata = { title: "Testing Lab" };

export default function Page() {
  return <TestingLab />;
}
