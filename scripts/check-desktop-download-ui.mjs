import { readFileSync } from "node:fs";

const component = readFileSync("components/DesktopPetDownload.tsx", "utf8");
const styles = readFileSync("app/globals.css", "utf8");
if (!component.includes("Download JARVIS Pet for Windows")) throw new Error("website must label the Windows pet download");
if (!component.includes("releases/latest/download/JARVIS-Desktop-Setup.exe")) throw new Error("website must use the stable latest installer URL");
if (!/@media\s*\(max-width:\s*640px\)[\s\S]*?\.desktop-pet-download\s*\{[\s\S]*?display:\s*none\s*;[\s\S]*?\}/.test(styles)) {
  throw new Error("desktop download card must stay hidden on mobile");
}

console.log("Desktop download UI check passed.");
