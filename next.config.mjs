// Keep the production build/start in a SEPARATE output dir from `next dev`.
// Otherwise `next build` (e.g. the coding pipeline's verify step) overwrites the
// running dev server's `.next` webpack chunks, causing "Cannot find module
// './XXXX.js'" on every request until `.next` is rebuilt. Dev keeps `.next`;
// build/start use `.next-build`.
// Detect the command from BOTH the npm script name and the actual Next CLI
// argv. npm_lifecycle_event is only set when run through `npm run build`; if a
// build is launched directly (`next build`, `npx next build`, or spawned by the
// coding/pipeline verify step) that var is empty and the old check fell back to
// `.next`, clobbering the running dev server. argv catches those cases.
const cmds = ["build", "start"];
const isProdBuild =
  cmds.includes(process.env.npm_lifecycle_event) ||
  process.argv.slice(2).some((a) => cmds.includes(a));

// On Vercel there's no local dev server to protect, and Vercel's Next.js
// detection expects the default ".next" (it looks for .next/routes-manifest.json).
// So the ".next-build" split is LOCAL-ONLY — skip it whenever building in CI/Vercel.
const isVercel = !!process.env.VERCEL;

/** @type {import('next').NextConfig} */
const nextConfig = {
  distDir: isProdBuild && !isVercel ? ".next-build" : ".next",
  output: isProdBuild && !isVercel ? "standalone" : undefined,
  // Expose the rotating proxy at a clean OpenAI base URL (/v1/...) in addition
  // to its real /api/v1/... route, so any OpenAI client can use `${origin}/v1`.
  async rewrites() {
    return [{ source: "/v1/:path*", destination: "/api/v1/:path*" }];
  },
};

export default nextConfig;
