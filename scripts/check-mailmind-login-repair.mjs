import { existsSync, readFileSync } from "node:fs";

function read(path) {
  if (!existsSync(path)) throw new Error(`Missing file: ${path}`);
  return readFileSync(path, "utf8");
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const callback = read("app/api/mail/auth-callback/route.ts");
const settings = read("components/mail/MailApp.tsx");

assert(
  /tokens\.refresh_token\s*\?\?\s*config\.accounts\[existing\]\?\.refreshToken/.test(callback),
  "Gmail OAuth callback must preserve the existing refresh token when Google omits a new one.",
);

const checkRoute = read("app/api/mail/check-accounts/route.ts");
assert(/refreshAccessToken/.test(checkRoute), "Account check route must validate Gmail refresh tokens.");
assert(/needsReconnect/.test(checkRoute), "Account check route must report accounts that need reconnecting.");
assert(/invalid_grant/.test(checkRoute), "Account check route must expose invalid_grant as an expired login state.");

const qrRoute = read("app/api/mail/auth-qr/route.ts");
assert(/qrcode/.test(qrRoute), "Gmail QR route must generate the QR locally, not through a third-party service.");
assert(/getAuthUrl/.test(qrRoute), "Gmail QR route must encode the real Google OAuth URL.");

assert(/check-accounts/.test(settings), "Settings UI must load Gmail account health.");
assert(/auth-qr/.test(settings), "Settings UI must show a Gmail login QR.");
assert(/Reconnect/.test(settings), "Settings UI must offer account reconnect.");

console.log("MailMind login repair checks passed.");
