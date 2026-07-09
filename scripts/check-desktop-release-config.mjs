import { existsSync, readFileSync } from "node:fs";

function read(path) {
  if (!existsSync(path)) throw new Error(`Missing file: ${path}`);
  return readFileSync(path, "utf8");
}

const pkg = JSON.parse(read("desktop/package.json"));
const publish = JSON.stringify(pkg.build?.publish || {});
if (!publish.includes("github") || !publish.includes("ltyfish") || !publish.includes("ai-personal-voice-assistant")) {
  throw new Error("desktop build must publish through the repository GitHub Releases");
}
if (pkg.build?.artifactName !== "JARVIS-Desktop-Setup.${ext}") {
  throw new Error("desktop installer must use a stable latest-release filename");
}
if (!JSON.stringify(pkg.build?.extraResources || []).includes("../Images")) {
  throw new Error("desktop installer must package the state image library");
}

const workflow = read(".github/workflows/release-desktop.yml");
for (const required of ["main", "contents: write", "windows-latest", "npm ci", "npm run build", "desktop test", "desktop run typecheck", "GH_TOKEN", "--publish always"]) {
  if (!workflow.includes(required)) throw new Error(`desktop release workflow missing: ${required}`);
}

console.log("Desktop release configuration check passed.");
