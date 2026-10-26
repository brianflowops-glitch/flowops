import type { Metadata } from "next";
import { Administration } from "@/components/views/administration";

export const metadata: Metadata = { title: "Administration" };

export default function Page() {
  return <Administration />;
}
