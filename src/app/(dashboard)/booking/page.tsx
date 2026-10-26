import type { Metadata } from "next";
import { BookingCenter } from "@/components/views/booking-center";

export const metadata: Metadata = { title: "Booking Center" };

export default function Page() {
  return <BookingCenter />;
}
