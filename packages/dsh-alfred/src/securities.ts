import type { HkSecurity } from './meta-db.js'

/**
 * Name resolution for HK securities against the cached securities master.
 *
 * Kept deterministic so it is unit-testable independent of the database and
 * network: given a query and a candidate list, it returns exactly one of
 *   - { status: 'resolved', code, nameZh, nameEn }
 *   - { status: 'ambiguous', matches }
 *   - { status: 'not-found' }
 *
 * Matching rules (agreed): exact unique -> resolve; prefix/fuzzy unique ->
 * resolve; more than one -> ambiguous (ask the user).
 */

export type ResolveResult =
  | { status: 'resolved'; code: string; nameZh: string; nameEn: string }
  | { status: 'ambiguous'; matches: HkSecurity[] }
  | { status: 'not-found' }

export function resolveByName(query: string, securities: HkSecurity[]): ResolveResult {
  const q = query.trim().toLowerCase()
  if (!q) return { status: 'not-found' }

  // 1. exact zh name
  const exactZh = securities.filter(s => s.nameZh.trim() === query.trim())
  if (exactZh.length === 1) return toResolved(exactZh[0])

  // 2. exact en name (case-insensitive)
  const exactEn = securities.filter(s => s.nameEn.trim().toLowerCase() === q)
  if (exactEn.length === 1) return toResolved(exactEn[0])

  // 3. prefix match on zh name
  const prefixZh = securities.filter(s => s.nameZh.trim().startsWith(query.trim()))
  if (prefixZh.length === 1) return toResolved(prefixZh[0])

  // 4. prefix match on en name
  const prefixEn = securities.filter(s => s.nameEn.trim().toLowerCase().startsWith(q))
  if (prefixEn.length === 1) return toResolved(prefixEn[0])

  // 5. contains match on zh name (fuzzy)
  const containsZh = securities.filter(s => s.nameZh.includes(query.trim()))
  if (containsZh.length === 1) return toResolved(containsZh[0])

  if (containsZh.length > 1) return { status: 'ambiguous', matches: containsZh }
  if (prefixZh.length > 1) return { status: 'ambiguous', matches: prefixZh }
  if (prefixEn.length > 1) return { status: 'ambiguous', matches: prefixEn }
  return { status: 'not-found' }
}

function toResolved(s: HkSecurity): ResolveResult {
  return { status: 'resolved', code: s.code, nameZh: s.nameZh, nameEn: s.nameEn }
}

/** Default TTL for the securities master cache: 24 hours. */
export const SECURITIES_TTL_MS = 24 * 60 * 60 * 1000
