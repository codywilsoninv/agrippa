"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export function NavLink({ href, label, badge }: { href: string; label: string; badge?: number }) {
  const pathname = usePathname();
  const active = pathname === href || pathname.startsWith(href + "/");
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={`flex items-center justify-between gap-3 rounded-md px-3 py-2.5 no-underline min-h-11 ${
        active ? "bg-nav-active text-white hover:text-white" : "text-nav-text hover:bg-nav-active hover:text-white"
      }`}
    >
      <span>{label}</span>
      {badge ? (
        <span className="rounded-full bg-nav-badge px-2 text-xs font-semibold text-ink leading-5">{badge}</span>
      ) : null}
    </Link>
  );
}
