import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { APP_VERSION } from "../js/protocol.js";
import { STR } from "../js/strings.js";

const root = new URL("../../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");

test("new name matches across web, Android, Capacitor and keeps the existing package ID", () => {
  const title = "EscortScope";
  const manifest = JSON.parse(read("app/manifest.webmanifest"));
  const capacitor = JSON.parse(read("capacitor.config.json"));
  const pkg = JSON.parse(read("package.json"));
  const lock = JSON.parse(read("package-lock.json"));
  const index = read("app/index.html");
  const android = read("android/app/src/main/res/values/strings.xml");
  const build = read("android/app/build.gradle");
  assert.equal(manifest.name, title);
  assert.equal(manifest.short_name, "EscortScope");
  assert.equal(capacitor.appName, title);
  assert.equal(pkg.name, "escort-sme105-diagnostic-lab");
  assert.equal(pkg.version, APP_VERSION);
  assert.equal(lock.name, pkg.name);
  assert.equal(lock.packages[""].name, pkg.name);
  assert.match(android, /<string name="app_name">EscortScope<\/string>/);
  assert.match(index, /<title>EscortScope · Ford Escort diagnostics by Basita<\/title>/);
  assert.equal(STR.appTitle, "EscortScope");
  assert.equal(STR.shortTitle, "FORD ESCORT · SME-105");
  assert.equal(capacitor.appId, "com.maximizotech.sme105dclstudio");
  assert.match(build, /applicationId "com\.maximizotech\.sme105dclstudio"/);
  assert.equal(APP_VERSION, "2.1.1");
  assert.match(build, /versionCode\s+29/);
});

test("official Basita assets are pinned, unchanged, and offline", () => {
  const css = read("app/styles.css");
  const index = read("app/index.html");
  const icon = read("app/icons/icon.svg");
  const tokens = read("app/brand/tokens.css");
  const manifest = JSON.parse(read("app/manifest.webmanifest"));
  const provenance = JSON.parse(read("app/brand/provenance.json"));
  const sw = read("app/sw.js");
  assert.equal(provenance.version, "1.0.0-rc.3");
  assert.equal(provenance.commit, "0d39988");
  for (const asset of provenance.assets) {
    const data = readFileSync(new URL("app/brand/" + asset.path, root));
    assert.equal(createHash("sha256").update(data).digest("hex"), asset.sha256, asset.path);
    if (/\.(svg|css|woff2|mp3|mp4|png)$/.test(asset.path)) assert.ok(sw.includes(`./brand/${asset.path}`), asset.path);
  }
  assert.match(tokens, /--basita-brand-lagoon: #2F797A/);
  assert.match(css, /@import url\("\.\/brand\/tokens\.css"\)/);
  assert.match(css, /--action: #2c4f7b/);
  assert.match(index, /brand\/logos\/basita-en-light\.svg/);
  assert.match(index, /brand\/logos\/basita-en-dark\.svg/);
  assert.match(index, /Developed by Basita/);
  assert.equal(manifest.theme_color.toLowerCase(), "#203b50");
  assert.match(icon, /fill="#203B50"/);
});

test("semantic statuses use authentic Basita tokens and restrained surfaces", () => {
  const css = read("app/styles.css");
  assert.match(css, /--warning: var\(--basita-functional-warning-light\)/);
  assert.match(css, /--warning: var\(--basita-functional-warning-dark\)/);
  assert.match(css, /--error: var\(--basita-functional-error-light\)/);
  assert.match(css, /--error: var\(--basita-functional-error-dark\)/);
  assert.doesNotMatch(css, /#ffe600|#ff0000/i);
  assert.match(css, /border-inline-start:4px solid var\(--warning\)/);
  assert.match(css, /body\.reduce-motion \.pending-motion/);
  const index = read("app/index.html");
  assert.doesNotMatch(index, /<audio[^>]*autoplay/);
  assert.match(index, /id="preview-brand-sound"/);
});

test("future exports have the new directory and historical files remain untouched", () => {
  const nativeSource = read("android/app/src/main/java/com/maximizotech/sme105dclstudio/ExportStoragePlugin.java");
  const appUi = read("app/js/ui.js");
  assert.match(nativeSource, /Download\/Escort SME-105 Diagnostic Lab/);
  assert.match(appUi, /Older exports remain in their original folder/);
  assert.match(read("docs/BRANDING_RELEASE.md"), /Download\/SME105 DCL Studio/);
});

test("regenerated web and Android icon PNGs have the expected pixel dimensions", () => {
  for (const [dpi, size] of [
    ["mdpi", 48], ["hdpi", 72], ["xhdpi", 96],
    ["xxhdpi", 144], ["xxxhdpi", 192],
  ]) {
    for (const [filename, pixels] of [
      ["ic_launcher.png", size],
      ["ic_launcher_round.png", size],
      ["ic_launcher_foreground.png", Math.round(size * 2.25)],
    ]) {
      const data = readFileSync(new URL("android/app/src/main/res/mipmap-" + dpi + "/" + filename, root));
      assert.equal(data.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
      assert.equal(data.readUInt32BE(16), pixels);
      assert.equal(data.readUInt32BE(20), pixels);
    }
  }
});
