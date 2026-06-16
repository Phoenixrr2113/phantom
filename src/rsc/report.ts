/**
 * Report emitters for the RSC readiness analysis. Three pure renderers over an
 * {@link RscReport}: machine-readable JSON, a Markdown document, and a compact
 * terminal summary. All sub-90% edge-resolution runs append a confidence caveat
 * because unresolved import edges under-propagate client-ness (over-reporting
 * server-eligibility).
 */

import type { RscReport } from './types.js';

/** Serialize the full report as pretty-printed JSON. */
export function toJSON(report: RscReport): string {
  return JSON.stringify(report, null, 2);
}

/** Render a compact, human-skimmable terminal summary of the report. */
export function toTerminal(report: RscReport): string {
  const lines: string[] = [];
  lines.push(`${report.componentFiles} component files · import graph ${report.edgeResolutionPct.toFixed(0)}% resolved`);
  lines.push(`Server-eligible: ${report.serverEligibleUpperBound} · Realizable after blast radius: ${report.realizableServerFiles} (${report.realizableServerPctBytes.toFixed(1)}% of component bytes)`);
  lines.push(`'use client' frontier: ${report.clientFrontier.length} files to mark`);
  if (report.rescues.length > 0) {
    lines.push(`Top rescues:`);
    for (const r of report.rescues.slice(0, 5)) lines.push(`  • ${r.hint}`);
  }
  if (report.hazards.length > 0) {
    lines.push(`Serialization hazards: ${report.hazards.length}`);
    for (const h of report.hazards.slice(0, 5)) lines.push(`  • ${h.file} — ${h.prop} (${h.kind})`);
  }
  if (report.edgeResolutionPct < 90) {
    lines.push(`⚠ edge resolution ${report.edgeResolutionPct.toFixed(0)}% (<90%) — realizable-server figures are a lower-confidence estimate.`);
  }
  return lines.join('\n');
}

/** Render the report as a Markdown document (frontier, rescues, hazards). */
export function toMarkdown(report: RscReport): string {
  const lines: string[] = [];
  lines.push(`# RSC Readiness Report`, ``);
  lines.push(`- **Component files:** ${report.componentFiles}`);
  lines.push(`- **Import-edge resolution:** ${report.edgeResolutionPct.toFixed(1)}%`);
  lines.push(`- **Server-eligible (upper bound):** ${report.serverEligibleUpperBound}`);
  lines.push(`- **Realizable server (after blast radius):** ${report.realizableServerFiles} files, ${report.realizableServerBytes} bytes (${report.realizableServerPctBytes.toFixed(1)}% of component bytes)`, ``);
  lines.push(`## \`'use client'\` frontier (${report.clientFrontier.length})`, ``);
  for (const f of report.clientFrontier) lines.push(`- \`${f}\``);
  lines.push(``, `## Rescue opportunities (${report.rescues.length})`, ``);
  for (const r of report.rescues) lines.push(`- ${r.hint}`);
  lines.push(``, `## Serialization hazards (${report.hazards.length})`, ``);
  for (const h of report.hazards) lines.push(`- \`${h.file}\` — \`${h.prop}\` (${h.kind})`);
  if (report.edgeResolutionPct < 90) {
    lines.push(``, `> ⚠ Import-edge resolution is ${report.edgeResolutionPct.toFixed(1)}% (below 90%). Treat realizable-server figures as a lower-confidence estimate — unresolved edges under-propagate client-ness.`);
  }
  return lines.join('\n');
}
