/**
 * The pre-generation script (ADR 0006): converts every bundled shiki theme
 * into a pi theme JSON under themes/, committed as package assets. pi
 * discovers them through the package manifest's `pi.themes` entry — zero
 * runtime generation for the bundled set.
 *
 * Diff roots (text) come from the theme's own diff declarations — the
 * `diffEditor.*TextBackground` tint passthrough, then the
 * markup.inserted/deleted marker, then the token greens/reds derivation —
 * the render-time palette derivation moved wholesale to generation time.
 * Families carry no separate diff colors (they never did — pairing data
 * only).
 *
 * Run: pnpm -C extensions/pi-pigment exec tsx scripts/generate-themes.ts
 * CI freshness: rerun + `git diff --exit-code themes/`.
 */

import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { themeNames } from "@shikijs/themes";

import { convertToPiTheme } from "#src/theme/pi-theme-converter.ts";
import { loadBundledThemeByName } from "#src/theme/theme-file.ts";

/** The output directory (package root / themes — pi's manifest points here). */
const THEMES_DIR = join(import.meta.dirname, "..", "themes");

async function main(): Promise<void> {
  // Clean slate: the directory is ours (generated assets, no hand edits —
  // customization copies OUT, per the documented policy).
  await rm(THEMES_DIR, { recursive: true, force: true });
  await mkdir(THEMES_DIR, { recursive: true });

  const warnings: string[] = [];
  const failures: string[] = [];
  let written = 0;
  const names = [...themeNames].toSorted();
  for (const name of names) {
    const file = await loadBundledThemeByName(name);
    if (!file) {
      failures.push(`failed to load bundled theme "${name}"`);
      continue;
    }
    // The loaded file carries its roots; the Converter reads them — a bundled
    // theme's declared diffEditor.*TextBackground tint then reaches its
    // registered toolDiff* slots instead of being dropped.
    const { doc, issues: convertIssues } = convertToPiTheme(file.theme, `pigment-${name}`, {
      diff: file.diffRoots,
    });
    // A conversion diagnostic (an AA conflict no color could satisfy, say) is
    // reported, never fatal: the theme still ships with the color it was
    // authored with, and only a theme that produces no file at all fails the
    // run. The check that keeps the committed assets honest only asserts they
    // match a fresh conversion — it is not a conflict gate — so these lines are
    // the report.
    for (const issue of convertIssues) warnings.push(issue.message);
    if (!doc) {
      failures.push(`theme "${name}" produced no theme file`);
      continue;
    }
    await writeFile(join(THEMES_DIR, `${doc.name}.json`), `${JSON.stringify(doc, null, "  ")}\n`);
    written++;
  }
  console.log(`[generate-themes] wrote ${written} themes to ${THEMES_DIR}`);
  for (const warning of warnings) console.error(`[generate-themes] ${warning}`);
  for (const failure of failures) console.error(`[generate-themes] ${failure}`);
  if (failures.length > 0) process.exitCode = 1;
}

void main();
