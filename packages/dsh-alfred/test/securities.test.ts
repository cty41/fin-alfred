import { describe, expect, it } from 'vitest'
import { resolveByName } from '../src/securities.js'
import type { HkSecurity } from '../src/meta-db.js'

const securities: HkSecurity[] = [
  { code: '00001', nameZh: '长和', nameEn: 'CKH HOLDINGS', currency: 'HKD', updatedAt: 't' },
  { code: '00700', nameZh: '腾讯控股', nameEn: 'TENCENT', currency: 'HKD', updatedAt: 't' },
  { code: '09633', nameZh: '农夫山泉', nameEn: 'NONGFU SPRING', currency: 'HKD', updatedAt: 't' },
  { code: '01024', nameZh: '快手-W', nameEn: 'KUAISHOU', currency: 'HKD', updatedAt: 't' },
  { code: '09988', nameZh: '阿里巴巴-W', nameEn: 'ALIBABA', currency: 'HKD', updatedAt: 't' },
  { code: '00388', nameZh: '香港交易所', nameEn: 'HKEX', currency: 'HKD', updatedAt: 't' },
]

describe('resolveByName', () => {
  it('resolves exact zh name', () => {
    expect(resolveByName('腾讯控股', securities)).toMatchObject({ status: 'resolved', code: '00700' })
  })

  it('resolves exact en name case-insensitively', () => {
    expect(resolveByName('tencent', securities)).toMatchObject({ status: 'resolved', code: '00700' })
    expect(resolveByName('NONGFU SPRING', securities)).toMatchObject({ status: 'resolved', code: '09633' })
  })

  it('resolves a unique prefix on zh name', () => {
    expect(resolveByName('农夫', securities)).toMatchObject({ status: 'resolved', code: '09633' })
  })

  it('resolves a unique prefix on en name', () => {
    expect(resolveByName('kuaish', securities)).toMatchObject({ status: 'resolved', code: '01024' })
  })

  it('returns ambiguous when a prefix matches several', () => {
    // both 香港交易所 and 港... only one has 香港 prefix; use a synthetic conflict
    const conf = [
      ...securities,
      { code: '01357', nameZh: '香港宽频', nameEn: 'HKBN', currency: 'HKD', updatedAt: 't' },
    ]
    const r = resolveByName('香港', conf)
    expect(r.status).toBe('ambiguous')
  })

  it('returns not-found for an unknown query', () => {
    expect(resolveByName('不存在的公司xyz', securities)).toEqual({ status: 'not-found' })
  })

  it('returns not-found for empty query', () => {
    expect(resolveByName('  ', securities)).toEqual({ status: 'not-found' })
  })
})
