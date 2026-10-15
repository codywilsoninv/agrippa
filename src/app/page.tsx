import { redirect } from "next/navigation";

// The inbox is the home screen. Signed-out visitors are sent to /login by the proxy.
export default function Home() {
  redirect("/messaging");
}
