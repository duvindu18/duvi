export default function Wordmark({ className = "" }: { className?: string }) {
  return (
    <span className={`inline-flex items-start font-serif leading-none tracking-[-0.02em] ${className}`}>
      Halde
      <span className="ml-[0.04em] mt-[0.12em] font-sans text-[0.14em] font-normal tracking-normal">®</span>
    </span>
  );
}
