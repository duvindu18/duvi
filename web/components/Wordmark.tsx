export default function Wordmark({ className = "" }: { className?: string }) {
  return (
    <span className={`inline-flex items-start font-display leading-none tracking-[-0.02em] ${className}`}>
      Halde.
    </span>
  );
}
