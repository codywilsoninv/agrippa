export function Wordmark({ className = "", size = 26 }: { className?: string; size?: number }) {
  return (
    <span
      className={`font-display tracking-wordmark ${className}`}
      style={{ fontSize: size, lineHeight: 1 }}
      aria-label="Agrippa"
    >
      AGRIPPA
    </span>
  );
}
