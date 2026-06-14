import { readFileSync } from "node:fs";

const source = readFileSync("lib/pipeline.ts", "utf8");
const expected = "C:\\Users\\User\\Downloads\\Projects\\Jarvis Personal AI";
const expectedLiteral = JSON.stringify(expected);

if (!source.includes(`process.env.PIPELINE_DIR || ${expectedLiteral}`)) {
  console.error(`FAIL: default PIPELINE_DIR must be ${expected}`);
  process.exit(1);
}

if (/Projects\\\\Hermes/.test(source)) {
  console.error("FAIL: pipeline default path/comment still points at Projects\\Hermes");
  process.exit(1);
}

console.log("pipeline store path ok");
