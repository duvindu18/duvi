import Link from "next/link";

export default function NotFound() {
  return (
    <div className="flex min-h-[80svh] flex-col items-start justify-center gap-8 px-4 sm:px-6 lg:px-14">
      <p className="label">[ 404 ]</p>
      <h1 className="font-display text-[clamp(42px,6vw,108px)] leading-[0.9]">
        This room <em>was never built.</em>
      </h1>
      <Link href="/archive" className="hairline-link text-[13px]">
        Return to the index →
      </Link>
    </div>
  );
}
