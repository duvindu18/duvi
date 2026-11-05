import type { Metadata } from "next";
import ArchiveIndex from "@/components/ArchiveIndex";

export const metadata: Metadata = { title: "Index" };

export default function ArchivePage() {
  return <ArchiveIndex />;
}
