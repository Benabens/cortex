import { enterCourse } from "@/db/client";
import { aggregateTopicsFromIndex } from "@/lib/program";
enterCourse(process.env.CORTEX_COURSE || "algo");
(async () => {
  const r = await aggregateTopicsFromIndex({ onStep: (s, p) => console.log(`[${p}%] ${s}`) });
  console.log("DONE:", JSON.stringify(r));
})().catch((e) => { console.error("FAIL:", e.message); process.exit(1); });
