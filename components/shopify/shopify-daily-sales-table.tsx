'use client'

import * as React from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import {
  ColumnDef,
  flexRender,
  getCoreRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  SortingState,
  useReactTable,
} from '@tanstack/react-table'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  IconChevronDown,
  IconChevronLeft,
  IconChevronRight,
  IconChevronsLeft,
  IconChevronsRight,
} from '@tabler/icons-react'

export type ShopifyDailySalesRow = {
  date: string // YYYY-MM-DD
  gross_sales_excl_tax: number | null
  discounts_excl_tax: number | null
  refunds_excl_tax: number | null
  net_sales_excl_tax: number | null
  orders_count: number | null
  currency: string | null
}

const formatCurrency = (value: number | null, currency: string = 'SEK') => {
  if (value === null || !Number.isFinite(value)) return '—'
  return new Intl.NumberFormat('sv-SE', {
    style: 'currency',
    currency: currency || 'SEK',
    maximumFractionDigits: 0,
  }).format(value)
}

function sum(values: Array<number | null | undefined>) {
  return values.reduce((acc, v) => acc + (v ?? 0), 0)
}

export function ShopifyDailySalesTable(props: {
  rows: ShopifyDailySalesRow[]
  from: string
  to: string
  supportsUpdatedAt?: boolean
  supportsCreatedAtTs?: boolean
}) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [sorting, setSorting] = React.useState<SortingState>([
    { id: 'date', desc: true },
  ])

  const currency = props.rows.find((r) => r.currency)?.currency ?? 'SEK'

  const supportsUpdatedAt = props.supportsUpdatedAt === true
  const supportsCreatedAtTs = props.supportsCreatedAtTs === true

  const groupBy = (searchParams.get('groupBy') as 'date_order' | 'date' | 'order') ?? 'date'
  const dateField =
    (searchParams.get('dateField') as 'processed_at' | 'created_at' | 'created_at_ts' | 'updated_at') ??
    'processed_at'
  const idField = (searchParams.get('idField') as 'order_id' | 'order_number') ?? 'order_id'

  const setQueryParam = (key: string, value: string) => {
    const params = new URLSearchParams(searchParams.toString())
    params.set(key, value)
    // Preserve tenant param in admin context
    const tenant = searchParams.get('tenant')
    if (tenant) params.set('tenant', tenant)
    router.push(`/admin/audits/orders?${params.toString()}`)
  }

  const handleDateChange = (field: 'from' | 'to', value: string) => {
    const params = new URLSearchParams(searchParams.toString())
    params.set(field, value)
    const tenant = searchParams.get('tenant')
    if (tenant) params.set('tenant', tenant)
    router.push(`/admin/audits/orders?${params.toString()}`)
  }

  const totals = React.useMemo(() => {
    const gross = sum(props.rows.map((r) => r.gross_sales_excl_tax))
    const discounts = sum(props.rows.map((r) => r.discounts_excl_tax))
    const returns = sum(props.rows.map((r) => r.refunds_excl_tax))
    const net = sum(props.rows.map((r) => r.net_sales_excl_tax))
    const orders = sum(props.rows.map((r) => r.orders_count))
    return { gross, discounts, returns, net, orders }
  }, [props.rows])

  const columns: ColumnDef<ShopifyDailySalesRow>[] = React.useMemo(
    () => [
      {
        accessorKey: 'date',
        header: 'Date',
        cell: ({ row }) => row.getValue('date') as string,
      },
      {
        accessorKey: 'gross_sales_excl_tax',
        header: 'Gross Sales',
        cell: ({ row }) =>
          formatCurrency(row.getValue('gross_sales_excl_tax') as number | null, currency),
      },
      {
        accessorKey: 'discounts_excl_tax',
        header: 'Discounts',
        cell: ({ row }) =>
          formatCurrency(row.getValue('discounts_excl_tax') as number | null, currency),
      },
      {
        accessorKey: 'refunds_excl_tax',
        header: 'Returns',
        cell: ({ row }) =>
          formatCurrency(row.getValue('refunds_excl_tax') as number | null, currency),
      },
      {
        accessorKey: 'net_sales_excl_tax',
        header: 'Net Sales',
        cell: ({ row }) =>
          formatCurrency(row.getValue('net_sales_excl_tax') as number | null, currency),
      },
      {
        accessorKey: 'orders_count',
        header: 'Orders',
        cell: ({ row }) => {
          const v = row.getValue('orders_count') as number | null
          return v === null ? '—' : String(v)
        },
      },
    ],
    [currency],
  )

  const table = useReactTable({
    data: props.rows,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    onSortingChange: setSorting,
    state: { sorting },
    initialState: { pagination: { pageSize: 31 } },
  })

  return (
    <div className="space-y-4">
      {/* Controls (match audits/orders UX) */}
      <div className="flex flex-wrap items-center gap-4">
        <div className="flex items-center gap-2">
          <label htmlFor="from" className="text-sm font-medium">
            From:
          </label>
          <Input
            id="from"
            type="date"
            value={props.from}
            onChange={(e) => handleDateChange('from', e.target.value)}
            className="w-40"
          />
        </div>
        <div className="flex items-center gap-2">
          <label htmlFor="to" className="text-sm font-medium">
            To:
          </label>
          <Input
            id="to"
            type="date"
            value={props.to}
            onChange={(e) => handleDateChange('to', e.target.value)}
            className="w-40"
          />
        </div>

        <div className="flex items-center gap-2">
          <label className="text-sm font-medium">Date field:</label>
          <Select value={dateField} onValueChange={(value) => setQueryParam('dateField', value)}>
            <SelectTrigger className="w-[180px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="processed_at">processed_at (report day)</SelectItem>
              <SelectItem value="created_at">created_at (date)</SelectItem>
              {supportsCreatedAtTs ? (
                <SelectItem value="created_at_ts">created_at_ts (timestamp)</SelectItem>
              ) : null}
              {supportsUpdatedAt ? (
                <SelectItem value="updated_at">updated_at (timestamp)</SelectItem>
              ) : null}
            </SelectContent>
          </Select>
        </div>

        <div className="flex items-center gap-2">
          <label className="text-sm font-medium">ID field:</label>
          <Select value={idField} onValueChange={(value) => setQueryParam('idField', value)}>
            <SelectTrigger className="w-[170px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="order_id">order_id</SelectItem>
              <SelectItem value="order_number">order_number</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="flex items-center gap-2">
          <label className="text-sm font-medium">Group by:</label>
          <Select value={groupBy} onValueChange={(value) => setQueryParam('groupBy', value)}>
            <SelectTrigger className="w-[190px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="date_order">Date + Order</SelectItem>
              <SelectItem value="date">Date only</SelectItem>
              <SelectItem value="order">Order only</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Summary (match audits/orders metrics) */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-5">
        <div className="rounded-lg border p-4">
          <div className="text-sm font-medium text-muted-foreground">Gross Sales</div>
          <div className="text-2xl font-semibold">{formatCurrency(totals.gross, currency)}</div>
        </div>
        <div className="rounded-lg border p-4">
          <div className="text-sm font-medium text-muted-foreground">Discounts</div>
          <div className="text-2xl font-semibold">
            {formatCurrency(totals.discounts, currency)}
          </div>
        </div>
        <div className="rounded-lg border p-4">
          <div className="text-sm font-medium text-muted-foreground">Returns</div>
          <div className="text-2xl font-semibold">{formatCurrency(totals.returns, currency)}</div>
        </div>
        <div className="rounded-lg border p-4">
          <div className="text-sm font-medium text-muted-foreground">Net Sales</div>
          <div className="text-2xl font-semibold">{formatCurrency(totals.net, currency)}</div>
        </div>
        <div className="rounded-lg border p-4">
          <div className="text-sm font-medium text-muted-foreground">Orders</div>
          <div className="text-2xl font-semibold">{Math.round(totals.orders)}</div>
        </div>
      </div>

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id}>
                {headerGroup.headers.map((header) => (
                  <TableHead key={header.id}>
                    {header.isPlaceholder ? null : (
                      <div
                        className={
                          header.column.getCanSort()
                            ? 'cursor-pointer select-none flex items-center gap-2'
                            : ''
                        }
                        onClick={header.column.getToggleSortingHandler()}
                      >
                        {flexRender(header.column.columnDef.header, header.getContext())}
                        {header.column.getIsSorted() && <IconChevronDown className="h-4 w-4" />}
                      </div>
                    )}
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {table.getRowModel().rows?.length ? (
              table.getRowModel().rows.map((row) => (
                <TableRow key={row.id}>
                  {row.getVisibleCells().map((cell) => (
                    <TableCell key={cell.id}>
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell colSpan={columns.length} className="h-24 text-center">
                  No rows found.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      <div className="flex items-center justify-between">
        <div className="text-sm text-muted-foreground">
          Showing {table.getState().pagination.pageIndex * table.getState().pagination.pageSize + 1} to{' '}
          {Math.min(
            (table.getState().pagination.pageIndex + 1) * table.getState().pagination.pageSize,
            table.getSortedRowModel().rows.length,
          )}{' '}
          of {table.getSortedRowModel().rows.length} days
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => table.setPageIndex(0)}
            disabled={!table.getCanPreviousPage()}
          >
            <IconChevronsLeft className="h-4 w-4" />
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => table.previousPage()}
            disabled={!table.getCanPreviousPage()}
          >
            <IconChevronLeft className="h-4 w-4" />
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => table.nextPage()}
            disabled={!table.getCanNextPage()}
          >
            <IconChevronRight className="h-4 w-4" />
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => table.setPageIndex(table.getPageCount() - 1)}
            disabled={!table.getCanNextPage()}
          >
            <IconChevronsRight className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  )
}


