import { randomUUID } from 'crypto'

type Row = Record<string, any>

const store = {
  connections: [] as Row[],
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

type Filter = { column: string; value: unknown }

function applyFilters(rows: Row[], filters: Filter[]) {
  return rows.filter((row) =>
    filters.every((filter) => {
      const parts = filter.column.split('->>')
      if (parts.length === 2) {
        const [field, jsonKey] = parts
        const meta = row[field]
        return (
          meta &&
          typeof meta === 'object' &&
          (meta as Record<string, unknown>)[jsonKey] === filter.value
        )
      }
      return row[filter.column] === filter.value
    }),
  )
}

class MutationBuilder {
  private readonly table: keyof typeof store
  private readonly type: 'update' | 'delete'
  private readonly payload: Row | null
  private readonly filters: Filter[]

  constructor(options: {
    table: keyof typeof store
    type: 'update' | 'delete'
    payload: Row | null
    filters: Filter[]
  }) {
    this.table = options.table
    this.type = options.type
    this.payload = options.payload
    this.filters = [...options.filters]
  }

  eq(column: string, value: unknown) {
    this.filters.push({ column, value })
    return this
  }

  private async execute() {
    const rows = applyFilters(store[this.table], this.filters)

    if (this.type === 'delete') {
      for (const row of rows) {
        const index = store[this.table].indexOf(row)
        if (index >= 0) {
          store[this.table].splice(index, 1)
        }
      }
      return { data: rows.map((row) => clone(row)), error: null }
    }

    if (this.type === 'update' && this.payload) {
      for (const row of rows) {
        Object.assign(row, clone(this.payload))
      }
      return { data: rows.map((row) => clone(row)), error: null }
    }

    return { data: [], error: null }
  }

  then<TResult1 = any, TResult2 = never>(
    onfulfilled?: ((value: any) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null,
  ) {
    return this.execute().then(onfulfilled, onrejected)
  }
}

class QueryBuilder {
  private readonly table: keyof typeof store
  private readonly filters: Filter[] = []

  constructor(table: keyof typeof store) {
    this.table = table
  }

  select() {
    return this
  }

  eq(column: string, value: unknown) {
    this.filters.push({ column, value })
    return this
  }

  async maybeSingle() {
    const rows = applyFilters(store[this.table], this.filters)
    const data = rows.length > 0 ? clone(rows[0]) : null
    return { data, error: null }
  }

  update(values: Row) {
    return new MutationBuilder({
      table: this.table,
      type: 'update',
      payload: values,
      filters: this.filters,
    })
  }

  async insert(payload: Row | Row[]) {
    const rows = Array.isArray(payload) ? payload : [payload]
    const inserted: Row[] = []

    for (const row of rows) {
      const record: Row = {
        id: row.id ?? randomUUID(),
        created_at: row.created_at ?? new Date().toISOString(),
        updated_at: row.updated_at ?? new Date().toISOString(),
        ...clone(row),
      }
      store[this.table].push(record)
      inserted.push(clone(record))
    }

    return { data: inserted, error: null }
  }

  delete() {
    return new MutationBuilder({
      table: this.table,
      type: 'delete',
      payload: null,
      filters: this.filters,
    })
  }
}

class SupabaseMockClient {
  from(table: string) {
    if (!(table in store)) {
      throw new Error(`Mock Supabase: unsupported table "${table}"`)
    }

    return new QueryBuilder(table as keyof TableStore)
  }
}

export function resetMockDb() {
  store.connections.length = 0
}

export function getConnectionsTable() {
  return store.connections
}

export function createSupabaseClient() {
  return new SupabaseMockClient()
}

