import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const config = [
  { ignores: [".next/**", "node_modules/**", "next-env.d.ts", ".claude/**"] },
  ...nextVitals,
  ...nextTs,
  {
    // The pages load their data in an effect on mount (fetch, then setState). The React compiler rule flags that
    // pattern; it is reported as a warning until data loading is moved out of effects.
    rules: { "react-hooks/set-state-in-effect": "warn" },
  },
];

export default config;
