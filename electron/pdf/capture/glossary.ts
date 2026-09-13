/**
 * electron/pdf/capture/glossary.ts — pre-translation abbreviation expansion.
 *
 * WHY: small translation models often mis-disambiguate common abbreviations
 * (e.g. "EM" → 电磁学 instead of 工程经理 in a software-engineering-management
 * book). Expanding them before sending text to the engine gives the model
 * enough context to produce the correct Chinese term, while the parenthetical
 * abbreviation is preserved in the output.
 *
 * The replacement is word-boundary aware so "EM" inside "THEME" or "EMPLOY"
 * is never touched.
 */

/** Abbreviation → expanded English form (the abbreviation is kept in parens). */
const GLOSSARY: Record<string, string> = {
  EM: 'Engineering Manager (EM)',
  EMs: 'Engineering Managers (EMs)',
  IC: 'Individual Contributor (IC)',
  ICs: 'Individual Contributors (ICs)',
  VP: 'Vice President (VP)',
  OKR: 'Objectives and Key Results (OKR)',
  OKRs: 'Objectives and Key Results (OKRs)',
  KPI: 'Key Performance Indicator (KPI)',
  KPIs: 'Key Performance Indicators (KPIs)',
  ROI: 'Return on Investment (ROI)',
  SRE: 'Site Reliability Engineer (SRE)',
  SREs: 'Site Reliability Engineers (SREs)',
  PR: 'Pull Request (PR)',
  PRs: 'Pull Requests (PRs)',
  CI: 'Continuous Integration (CI)',
  CD: 'Continuous Deployment (CD)'
}

/** Build a single regex that matches any glossary key as a whole word. */
const pattern = new RegExp(
  `\\b(${Object.keys(GLOSSARY).map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`,
  'g'
)

/**
 * Expand known abbreviations in `text` before translation.
 * Returns the expanded text (e.g. "an EM role" → "an Engineering Manager (EM) role").
 */
export function expandAbbreviations(text: string): string {
  return text.replace(pattern, (match) => GLOSSARY[match] ?? match)
}
