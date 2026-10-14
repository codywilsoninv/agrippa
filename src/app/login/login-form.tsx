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
      <p className="text-sm bg-[#DCFCE7] text-[#14532D] rounded-lg p-4">
        Check your inbox for a sign-in link sent to <strong>{email}</strong>.
      </p>
    );
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-3">
      <label htmlFor="email" className="text-sm font-medium">
        Email
      </label>
      <input
        id="email"
        type="email"
        required
        autoComplete="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        className="min-h-11 rounded-lg border border-[#D6D3CA] px-3"
      />
      <button
        type="submit"
        disabled={state === "sending"}
        className="min-h-11 rounded-lg bg-[#1A1B1E] text-white font-semibold disabled:opacity-60"
      >
        {state === "sending" ? "Sending…" : "Send sign-in link"}
      </button>
      {state === "error" && (
        <p role="alert" className="text-sm text-[#B91C1C]">
          {message}
        </p>
      )}
    </form>
  );
}
