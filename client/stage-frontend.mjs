// Stages the static frontend into dist/ for Tauri bundling — only the files the
// app needs (index.html + src), never node_modules/dev artifacts.
import { rmSync, mkdirSync, cpSync } from "fs";

rmSync("dist", { recursive: true, force: true });
mkdirSync("dist", { recursive: true });
cpSync("index.html", "dist/index.html");
cpSync("src", "dist/src", { recursive: true });
console.log("staged frontend -> dist/");
