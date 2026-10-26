import type { Metadata } from "next";
import { ForgotPasswordForm } from "@/components/auth/password-reset";

export const metadata: Metadata = { title: "Forgot password" };

export default function Page() {
  return <ForgotPasswordForm />;
}
