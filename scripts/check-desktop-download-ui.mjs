import { readFileSync } from "node:fs";

const component = readFileSync("components/DesktopPetDownload.tsx", "utf8");
if (!component.includes("Download JARVIS Pet for Windows")) throw new Error("website must label the Windows pet download");
if (!component.includes("releases/latest/download/JARVIS-Desktop-Setup.exe")) throw new Error("website must use the stable latest installer URL");

console.log("Desktop download UI check passed.");
