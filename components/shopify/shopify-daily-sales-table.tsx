'use client'

import * as React from 'react'
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

export function ShopifyDailySalesTable(props: { rows: ShopifyDailySalesRow[] }) {
  const [sorting, setSorting] = React.useState<SortingState>([
    { id: 'date', desc: true },
  ])

  const currency = props.rows.find((r) => r.currency)?.currency ?? 'SEK'

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


