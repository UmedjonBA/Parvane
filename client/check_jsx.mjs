import { transformFileSync } from "@babel/core";
import { readdirSync, statSync } from "fs";
import { join } from "path";
const files = [];
function walk(dir) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p);
    else if (p.endsWith(".jsx")) files.push(p);
  }
}
walk("src");
let ok = 0, bad = 0;
for (const f of files.sort()) {
  try {
    transformFileSync(f, { presets: ["@babel/preset-react"], babelrc: false, configFile: false });
    console.log("  ✓", f); ok++;
  } catch (e) {
    console.log("  ✗", f, "\n     ", e.message.split("\n")[0]); bad++;
  }
}
console.log(`\n${ok} ok, ${bad} failed`);
process.exit(bad ? 1 : 0);
