import { redirect } from "next/navigation";

// Email lives on the main page now as tabs (Assistant · Inbox · Digest ·
// Urgency · Settings). Keep this path working by sending it home.
export default function MailPage() {
  redirect("/");
}
