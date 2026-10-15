"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";

export function LoginForm() {
  const [email, setEmail] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [message, setMessage] = useState("");

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setState("sending");
    const supabase = createClient();
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: `${window.location.origin}/auth/callback` },
    });
    if (error) {
      setState("error");
      setMessage(error.message);
    } else {
      setState("sent");
    }
  }

  if (state === "sent") {
    return (
      <p role="status" className="m-0 rounded-sm bg-ok-soft p-4 text-sm text-ok">
        Check your inbox for a sign-in link sent to <strong className="font-semibold">{email}</strong>.
      </p>
    );
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-3">
      <label htmlFor="email" className="label-caps">
        Email
      </label>
      <input
        id="email"
        type="email"
        required
        autoComplete="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        className="input-base"
      />
      <button type="submit" disabled={state === "sending"} className="btn-primary disabled:opacity-60">
        {state === "sending" ? "Sending…" : "Send sign-in link"}
      </button>
      {state === "error" && (
        <p role="alert" className="m-0 text-sm text-danger">
          {message}
        </p>
      )}
    </form>
  );
}
