import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AlfredMetaDb, DEFAULT_META_DB_FILENAME } from '../src/meta-db.js'

let dir: string
let meta: AlfredMetaDb

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alfred-meta-'))
  meta = new AlfredMetaDb({ dataDir: dir })
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('AlfredMetaDb', () => {
  it('creates a separate meta database file, not the ledger file', () => {
    meta.open().close()
    const files = fs.readdirSync(dir)
    expect(files).toContain(DEFAULT_META_DB_FILENAME)
    expect(files).not.toContain('alfred.db')
  })

  it('migrates idempotently', () => {
    meta.open().close()
    meta.open().close() // second open must not error
    const db = new DatabaseSync(path.join(dir, DEFAULT_META_DB_FILENAME))
    const v = db.prepare('SELECT version FROM schema_version ORDER BY version DESC LIMIT 1').get() as { version: number }
    expect(v.version).toBe(2)
    db.close()
  })

  it('upserts and reads securities', () => {
    meta.upsertSecurities([
      { code: '00001', nameZh: '长和', nameEn: 'CKH HOLDINGS', currency: 'HKD', updatedAt: '2026-08-20T00:00:00Z' },
      { code: '00700', nameZh: '腾讯控股', nameEn: 'TENCENT', currency: 'HKD', updatedAt: '2026-08-20T00:00:00Z' },
    ])
    expect(meta.getSecurity('00001')).toMatchObject({ code: '00001', nameZh: '长和' })
    expect(meta.listSecurities()).toHaveLength(2)
    expect(meta.securitiesUpdatedAt()).toBe('2026-08-20T00:00:00Z')

    // upsert replaces existing row rather than duplicating
    meta.upsertSecurities([{ code: '00001', nameZh: '长和集团', nameEn: 'CKH', currency: 'HKD', updatedAt: '2026-08-21T00:00:00Z' }])
    expect(meta.listSecurities()).toHaveLength(2)
    expect(meta.getSecurity('00001')).toMatchObject({ nameZh: '长和集团' })
  })

  it('upserts and reads cached financial statements by (instrument, period, kind)', () => {
    meta.upsertFinancial('balance', 'HKEX:0700', '2026-06-30', '[{"a":1}]', '人民币', '2026-08-20T00:00:00Z')
    const got = meta.getFinancial('HKEX:0700', '2026-06-30', 'balance')
    expect(got).toMatchObject({ instrumentId: 'HKEX:0700', period: '2026-06-30', kind: 'balance', currency: '人民币' })
    expect(JSON.parse(got!.rowsJson)).toEqual([{ a: 1 }])

    // kind is part of the key
    expect(meta.getFinancial('HKEX:0700', '2026-06-30', 'income')).toBeUndefined()
  })

  it('upserts and reads the latest cached price', () => {
    meta.upsertPrice('HKEX:0700', '447.2', '442.4', '2026-08-19T16:00:00Z', 'akshare')
    meta.upsertPrice('HKEX:0700', '448.0', '442.4', '2026-08-20T16:00:00Z', 'akshare')
    const latest = meta.getLatestPrice('HKEX:0700')
    expect(latest).toMatchObject({ price: '448.0', previousClose: '442.4' })
  })
})
