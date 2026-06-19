import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const componentPath = path.join(root, "components", "LLMKeys.tsx");
const cssPath = path.join(root, "app", "mail", "mail.css");

const component = fs.readFileSync(componentPath, "utf8");
const css = fs.readFileSync(cssPath, "utf8");

for (const token of [
  "llm-leader-row",
  "llm-leader-model",
  "llm-model-row",
  "llm-action-enable",
  "Enable",
]) {
  if (!component.includes(token)) {
    throw new Error(`LLMKeys is missing mobile/enable token: ${token}`);
  }
}

for (const token of [
  "@media (max-width:760px)",
  ".llm-leader-row",
  ".llm-model-row",
  ".llm-leader-model",
  ".llm-action-enable",
]) {
  if (!css.includes(token)) {
    throw new Error(`mail.css is missing LLM Keys mobile rule: ${token}`);
  }
}

console.log("LLM Keys mobile layout and re-enable controls are wired");
