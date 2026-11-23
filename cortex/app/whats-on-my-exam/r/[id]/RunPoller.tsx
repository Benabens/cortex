"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/** Suit une analyse en cours : dès qu'elle n'est plus « running », la page se recharge côté serveur. */
export function RunPoller({ id }: { id: string }) {
  const router = useRouter();
  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      const view = await fetch(`/api/exam-topics/${id}`, { cache: "no-store" }).then((r) => r.json()).catch(() => null) as { status?: string } | null;
      if (stop) return;
      if (view?.status && view.status !== "running") { router.refresh(); return; }
      timer = setTimeout(tick, 2500);
    };
    timer = setTimeout(tick, 2000);
    return () => { stop = true; clearTimeout(timer); };
  }, [id, router]);
  return (
    <div aria-hidden className="mx-auto flex w-40 flex-col gap-2">
      <div className="h-2 animate-pulse rounded-full motion-reduce:animate-none" style={{ background: "var(--bare-line)" }} />
      <div className="mx-auto h-2 w-3/4 animate-pulse rounded-full motion-reduce:animate-none" style={{ background: "var(--bare-line)" }} />
    </div>
  );
}
