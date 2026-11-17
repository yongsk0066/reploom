import { createReactPolicy } from "../../packages/runtime/src/execution/adapters/react.ts";

export const reactConfig = {
  key: "test-react",
  runtime: "react",
  entry: "/App.js",
  styles: ["/styles.css"],
  imports: Object.fromEntries(
    ["react", "react/jsx-dev-runtime", "react/jsx-runtime", "react-dom", "react-dom/client"].map(
      (name) => [name, `vendor:${name}`],
    ),
  ),
  dependencyFiles: {},
};

export function reactPolicy({ React, RefreshRuntime, JSXDevRuntime }) {
  return createReactPolicy(
    {
      react: { ...React, default: React },
      "react/jsx-dev-runtime": JSXDevRuntime,
    },
    RefreshRuntime,
  );
}
