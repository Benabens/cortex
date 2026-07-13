import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
  {
    // Les route handlers / scripts ne sont PAS du React : `useCourse(req)` (contexte
    // cours+user, lib/req.ts) déclenche à tort react-hooks/rules-of-hooks depuis que
    // les handlers sont async (façade DB async, Phase B backend-overhaul).
    files: ["app/**/route.ts", "scripts/**", "lib/**", "db/**"],
    rules: {
      "react-hooks/rules-of-hooks": "off",
    },
  },
]);

export default eslintConfig;
