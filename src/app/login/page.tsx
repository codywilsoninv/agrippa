import { Wordmark } from "@/components/wordmark";
import { LoginForm } from "./login-form";

export const metadata = { title: "Sign in · Agrippa" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string | string[] }> }) {
  const { error } = await searchParams;
  const linkFailed = (Array.isArray(error) ? error[0] : error) === "link";

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-8 bg-ground px-4 py-10">
      <Wordmark size={34} />
      <div className="flex w-full max-w-sm flex-col gap-5 rounded-sm border-t-[3px] border-accent bg-surface p-8">
        <div className="flex flex-col gap-1">
          <h1 className="m-0 font-display text-2xl font-normal">Sign in</h1>
          <p className="m-0 text-sm text-muted">Enter your email and we&apos;ll send you a one-time link.</p>
        </div>
        {linkFailed ? (
          <p role="alert" className="m-0 rounded-sm bg-danger-soft px-3 py-2 text-sm text-danger">
            That sign-in link didn&apos;t work. It may have expired; request a new one.
          </p>
        ) : null}
        <LoginForm />
      </div>
      <p className="m-0 text-xs text-muted">Operational AI for every business</p>
    </main>
  );
}
