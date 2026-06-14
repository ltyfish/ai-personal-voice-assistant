import { readFileSync } from "node:fs";

const mailApp = readFileSync("components/mail/MailApp.tsx", "utf8");
const css = readFileSync("app/mail/mail.css", "utf8");

const mustInclude = [
  "const MORE_TAB_IDS",
  "const primaryTabs",
  "const moreTabs",
  "nav-more",
  "nav-more-menu",
  "selectTab(t.id)",
];

for (const needle of mustInclude) {
  if (!mailApp.includes(needle) && !css.includes(needle)) {
    console.error(`FAIL: missing ${needle}`);
    process.exit(1);
  }
}

for (const id of ["tasks", "notes", "projects", "feed", "digest", "urgency"]) {
  const re = new RegExp(`MORE_TAB_IDS[\\s\\S]*"${id}"`);
  if (!re.test(mailApp)) {
    console.error(`FAIL: ${id} must be grouped in MORE_TAB_IDS`);
    process.exit(1);
  }
}

const primaryOrder = [
  'id: "assistant"',
  'id: "freellmapi"',
  'id: "local"',
  'id: "calendar"',
  'id: "abilities"',
  'id: "settings"',
];
let last = -1;
for (const needle of primaryOrder) {
  const next = mailApp.indexOf(needle);
  if (next < 0) {
    console.error(`FAIL: missing primary tab ${needle}`);
    process.exit(1);
  }
  if (next < last) {
    console.error("FAIL: primary tabs are not in the requested order");
    process.exit(1);
  }
  last = next;
}

console.log("nav overflow menu wiring ok");
