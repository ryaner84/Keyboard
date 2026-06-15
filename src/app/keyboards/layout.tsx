"use client";

import { useState } from "react";
import { KeyboardSubNav } from "@/components/keyboards/KeyboardSubNav";
import { ContributeModal, ContributeFab } from "@/components/keyboards/ContributeButton";

export default function KeyboardsLayout({ children }: { children: React.ReactNode }) {
  const [contributeOpen, setContributeOpen] = useState(false);

  return (
    <>
      <KeyboardSubNav />
      {children}
      <ContributeFab onClick={() => setContributeOpen(true)} />
      <ContributeModal isOpen={contributeOpen} onClose={() => setContributeOpen(false)} />
    </>
  );
}
