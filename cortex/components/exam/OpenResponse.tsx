"use client";

import { useId, useState } from "react";
import { SafeHtml } from "@/components/ui/SafeHtml";

export function OpenResponse({ questionId, graded, solution }: {
  questionId: number;
  graded: boolean;
  solution: string | null;
}) {
  const [answer, setAnswer] = useState("");
  const instanceId = useId();
  const textareaId = `open-response-${questionId}-${instanceId}`;

  return (
    <div className="mt-3">
      <label htmlFor={textareaId} className="mb-1 block text-[12.5px]" style={{ color: "var(--ink-2)" }}>
        Ta réponse
      </label>
      <textarea
        id={textareaId}
        className="textarea w-full"
        rows={4}
        placeholder="Ta réponse (auto-évaluée : le corrigé s’affiche après correction)…"
        style={{ fontSize: 13 }}
        value={answer}
        onChange={(e) => setAnswer(e.target.value)}
        readOnly={graded}
      />
      {graded && solution && (
        <details className="mt-3" open>
          <summary className="text-[12.5px] cursor-pointer" style={{ color: "var(--green-ink)" }}>Corrigé</summary>
          <SafeHtml className="prose-exam text-[13px] mt-2" style={{ color: "var(--ink-2)" }} html={solution} />
        </details>
      )}
    </div>
  );
}
