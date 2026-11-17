import { useMemo } from "react";
import { useLocale } from "use-intl/react";
import { fmt, type Fmt } from "./format";

/** Formats de la langue courante, dans un Client Component. */
export function useFmt(): Fmt {
  const locale = useLocale();
  return useMemo(() => fmt(locale), [locale]);
}
