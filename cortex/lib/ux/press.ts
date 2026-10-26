"use client";

import { useCallback, useRef, useState } from "react";

type PressHandlers = {
  onPointerDown: (e: React.PointerEvent<HTMLElement>) => void;
  onPointerEnter: (e: React.PointerEvent<HTMLElement>) => void;
  onPointerLeave: () => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLElement>) => void;
  onKeyUp: (e: React.KeyboardEvent<HTMLElement>) => void;
  onBlur: () => void;
};

/**
 * État « appuyé » d'un contrôle, tenu jusqu'au relâché : c'est lui qui porte la compression
 * des interrupteurs. `K` identifie l'élément appuyé quand plusieurs partagent le même état
 * (les options d'un contrôle segmenté).
 *
 * `:active` ne convient pas : selon le navigateur il reste posé quand le pointeur quitte le
 * bouton, alors que le clic, lui, est déjà annulé. Ici l'état suit ce qui se passera vraiment
 * au relâché : sortir du bouton le relâche (on a changé d'avis), y revenir sans avoir lâché le
 * réarme. L'action elle-même reste le `click` natif, donc clavier et lecteurs d'écran ne
 * dépendent pas de ce hook.
 */
export function usePress<K = true>() {
  const [pressed, setPressed] = useState<K | null>(null);
  const armed = useRef<K | null>(null);

  const bind = useCallback((key: K): PressHandlers => {
    const release = () => setPressed((p) => (p === key ? null : p));
    return {
      onPointerDown: (e) => {
        if (e.button !== 0) return;
        // Au doigt, le navigateur capture le pointeur sur le bouton : sans la relâcher, on ne
        // saurait jamais que le doigt en est sorti.
        if (e.currentTarget.hasPointerCapture?.(e.pointerId)) {
          e.currentTarget.releasePointerCapture(e.pointerId);
        }
        armed.current = key;
        setPressed(key);
        const disarm = () => {
          armed.current = null;
          setPressed(null);
          window.removeEventListener("pointerup", disarm);
          window.removeEventListener("pointercancel", disarm);
        };
        window.addEventListener("pointerup", disarm);
        window.addEventListener("pointercancel", disarm);
      },
      onPointerEnter: (e) => {
        if (armed.current === key && e.buttons & 1) setPressed(key);
      },
      onPointerLeave: release,
      onKeyDown: (e) => {
        if ((e.key === " " || e.key === "Enter") && !e.repeat) setPressed(key);
      },
      onKeyUp: (e) => {
        if (e.key === " " || e.key === "Enter") release();
      },
      onBlur: release,
    };
  }, []);

  return { pressed, bind };
}
