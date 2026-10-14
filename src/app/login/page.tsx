import { LoginForm } from "./login-form";

export const metadata = { title: "Sign in · Agrippa" };

export default function LoginPage() {
  return (
    <main className="min-h-screen flex items-center justify-center px-4 bg-[#F5F4F0]">
      <div className="w-full max-w-sm bg-white border border-[#E3E1DA] rounded-2xl p-8">
        <h1 className="text-2xl font-semibold mb-1">Agrippa</h1>
        <p className="text-sm text-[#5C5F66] mb-6">
          Sign in with your email. We&apos;ll send you a one-time link.
        </p>
        <LoginForm />
      </div>
    </main>
  );
}
