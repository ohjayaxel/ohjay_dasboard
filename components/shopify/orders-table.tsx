'use client'

import * as React from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import {
  ColumnDef,
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  SortingState,
  useReactTable,
} from '@tanstack/react-table'
import {
  IconChevronDown,
  IconChevronLeft,
  IconChevronRight,
  IconChevronsLeft,
  IconChevronsRight,
} from '@tabler/icons-react'

import { Badge } from '@/components/ui/badge'
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

type ShopifyOrder = {
  order_id: string
  processed_at: string | null
  total_price: number | null
  total_tax: number | null
  gross_sales: number | null
  net_sales: number | null
  discount_total: number | null
  total_refunds: number | null
  currency: string | null
  financial_status: string | null
  fulfillment_status: string | null
  source_name: string | null
  is_refund: boolean | null
}

type OrdersTableProps = {
  orders: ShopifyOrder[]
  from: string
  to: string
  tenantSlug?: string // Optional for admin context
}

const formatCurrency = (value: number | null, currency: string = 'SEK') => {
  if (value === null || !Number.isFinite(value)) return '—'
  return new Intl.NumberFormat('sv-SE', {
    style: 'currency',
    currency: currency || 'SEK',
    maximumFractionDigits: 0,
  }).format(value)
}

const getNumericValue = (value: number | null | undefined) => {
  if (typeof value === 'number' && !Number.isNaN(value)) {
    return value
  }
  if (typeof value === 'string') {
    const parsed = parseFloat(value)
    return Number.isFinite(parsed) ? parsed : 0
  }
  return 0
}

const formatDate = (date: string | null) => {
  if (!date) return '—'
  return new Date(date).toLocaleDateString('sv-SE')
}

export function OrdersTable({ orders, from, to, tenantSlug }: OrdersTableProps) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [sorting, setSorting] = React.useState<SortingState>([])
  const [globalFilter, setGlobalFilter] = React.useState('')

  const handleDateChange = (field: 'from' | 'to', value: string) => {
    const params = new URLSearchParams(searchParams.toString())
    params.set(field, value)
    // Support both tenant context and admin context
    const isAdminContext = typeof window !== 'undefined' && window.location.pathname.includes('/admin/audits/orders')
    if (isAdminContext) {
      // Preserve tenant param if exists
      const tenant = searchParams.get('tenant')
      if (tenant) params.set('tenant', tenant)
      router.push(`/admin/audits/orders?${params.toString()}`)
    } else if (tenantSlug) {
      router.push(`/t/${tenantSlug}/shopify/orders?${params.toString()}`)
    }
  }

  // Filter orders that are included in gross sales calculation
  // Include all orders with gross_sales > 0 (both regular orders and refunds)
  const includedOrders = orders.filter((o) => parseFloat((o.gross_sales || 0).toString()) > 0)
  const excludedOrders = orders.filter((o) => parseFloat((o.gross_sales || 0).toString()) === 0)

  const columns: ColumnDef<ShopifyOrder>[] = React.useMemo(
    () => [
      {
        accessorKey: 'order_id',
        header: 'Order ID',
        cell: ({ row }) => (
          <div className="font-mono text-sm">{row.getValue('order_id')}</div>
        ),
      },
      {
        accessorKey: 'processed_at',
        header: 'Date',
        cell: ({ row }) => formatDate(row.getValue('processed_at')),
      },
      {
        accessorKey: 'gross_sales',
        header: 'Total Sales',
        cell: ({ row }) => {
          const totalSales = row.getValue('gross_sales') as number | null
          const currency = row.original.currency || 'SEK'
          return (
            <div className={totalSales && totalSales > 0 ? 'font-medium' : 'text-muted-foreground'}>
              {formatCurrency(totalSales, currency)}
            </div>
          )
        },
      },
      {
        accessorKey: 'total_tax',
        header: 'Tax',
        cell: ({ row }) => {
          const tax = row.original.total_tax as number | null
          const currency = row.original.currency || 'SEK'
          return (
            <div className="text-muted-foreground">
              {formatCurrency(tax, currency)}
            </div>
          )
        },
      },
      {
        id: 'gross_sales_calculated',
        header: 'Gross Sales',
        accessorFn: (row) => {
          if (row.gross_sales === null || row.gross_sales === undefined) {
            return null
          }
          const tax = getNumericValue(row.total_tax)
          return row.gross_sales - tax
        },
        cell: ({ row }) => {
          const totalSales = row.original.gross_sales as number | null
          const tax = row.original.total_tax as number | null
          const currency = row.original.currency || 'SEK'
          const grossSales =
            totalSales !== null && totalSales !== undefined
              ? totalSales - getNumericValue(tax)
              : null
          return (
            <div
              className={
                grossSales !== null && grossSales > 0 ? 'font-medium' : 'text-muted-foreground'
              }
            >
              {formatCurrency(grossSales, currency)}
            </div>
          )
        },
      },
      {
        accessorKey: 'discount_total',
        header: 'Discounts',
        cell: ({ row }) => {
          const discount = row.getValue('discount_total') as number | null
          const currency = row.original.currency || 'SEK'
          return (
            <div className="text-muted-foreground">
              {formatCurrency(discount, currency)}
            </div>
          )
        },
      },
      {
        accessorKey: 'total_refunds',
        header: 'Returns',
        cell: ({ row }) => {
          const refunds = row.getValue('total_refunds') as number | null
          const currency = row.original.currency || 'SEK'
          return (
            <div className="text-muted-foreground">
              {formatCurrency(refunds, currency)}
            </div>
          )
        },
      },
      {
        accessorKey: 'net_sales',
        header: 'Net Sales',
        cell: ({ row }) => {
          const net = row.getValue('net_sales') as number | null
          const currency = row.original.currency || 'SEK'
          return <div className="font-medium">{formatCurrency(net, currency)}</div>
        },
      },
      {
        accessorKey: 'financial_status',
        header: 'Status',
        cell: ({ row }) => {
          const status = row.getValue('financial_status') as string | null
          return status ? (
            <Badge variant="outline" className="text-xs">
              {status}
            </Badge>
          ) : (
            <span className="text-muted-foreground">—</span>
          )
        },
      },
      {
        accessorKey: 'source_name',
        header: 'Source',
        cell: ({ row }) => {
          const source = row.getValue('source_name') as string | null
          return source ? (
            <Badge variant="secondary" className="text-xs">
              {source}
            </Badge>
          ) : (
            <span className="text-muted-foreground">—</span>
          )
        },
      },
      {
        id: 'included',
        header: 'Included',
        cell: ({ row }) => {
          const gross = parseFloat((row.original.gross_sales || 0).toString())
          return gross > 0 ? (
            <Badge className="bg-green-600">Yes</Badge>
          ) : (
            <Badge variant="outline">No</Badge>
          )
        },
      },
    ],
    []
  )

  const table = useReactTable({
    data: orders,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    onSortingChange: setSorting,
    onGlobalFilterChange: setGlobalFilter,
    state: {
      sorting,
      globalFilter,
    },
    initialState: {
      pagination: {
        pageSize: 50,
      },
    },
  })

  // Calculate totals: add all included orders (both regular orders and refunds)
  const totalSalesSum = includedOrders.reduce((sum, order) => {
    return sum + getNumericValue(order.gross_sales)
  }, 0)

  const totalGrossSales = includedOrders.reduce((sum, order) => {
    const totalSalesValue = getNumericValue(order.gross_sales)
    const taxValue = getNumericValue(order.total_tax)
    return sum + (totalSalesValue - taxValue)
  }, 0)

  const totalNetSales = includedOrders.reduce((sum, order) => {
    return sum + getNumericValue(order.net_sales)
  }, 0)

  return (
    <div className="space-y-4">
      {/* Date filters */}
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-2">
          <label htmlFor="from" className="text-sm font-medium">
            From:
          </label>
          <Input
            id="from"
            type="date"
            value={from}
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
            value={to}
            onChange={(e) => handleDateChange('to', e.target.value)}
            className="w-40"
          />
        </div>
      </div>

      {/* Summary */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-lg border p-4">
          <div className="text-sm text-muted-foreground">Included Orders</div>
          <div className="text-2xl font-semibold">{includedOrders.length}</div>
        </div>
        <div className="rounded-lg border p-4">
          <div className="text-sm font-medium text-muted-foreground">Total Sales</div>
          <div className="text-2xl font-semibold">{formatCurrency(totalSalesSum)}</div>
          <p className="mt-1 text-xs text-muted-foreground">
            SUM(line_item.price × quantity) before discounts, tax, or shipping.
          </p>
        </div>
        <div className="rounded-lg border p-4">
          <div className="text-sm font-medium text-muted-foreground">Gross Sales</div>
          <div className="text-2xl font-semibold">{formatCurrency(totalGrossSales)}</div>
          <p className="mt-1 text-xs text-muted-foreground">Total Sales minus collected tax.</p>
        </div>
        <div className="rounded-lg border p-4">
          <div className="text-sm font-medium text-muted-foreground">Net Sales</div>
          <div className="text-2xl font-semibold">{formatCurrency(totalNetSales)}</div>
          <p className="mt-1 text-xs text-muted-foreground">
            Gross Sales minus Discounts and Returns.
          </p>
        </div>
      </div>

      {/* Search */}
      <div className="flex items-center gap-4">
        <Input
          placeholder="Search order ID..."
          value={globalFilter}
          onChange={(e) => setGlobalFilter(e.target.value)}
          className="max-w-sm"
        />
        <Select
          value={table.getState().pagination.pageSize.toString()}
          onValueChange={(value) => {
            table.setPageSize(Number(value))
          }}
        >
          <SelectTrigger className="w-32">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="25">25 rows</SelectItem>
            <SelectItem value="50">50 rows</SelectItem>
            <SelectItem value="100">100 rows</SelectItem>
            <SelectItem value="250">250 rows</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Table */}
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
                        {header.column.getIsSorted() && (
                          <IconChevronDown className="h-4 w-4" />
                        )}
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
                <TableRow
                  key={row.id}
                  data-state={row.getIsSelected() && 'selected'}
                  className={
                    parseFloat((row.original.gross_sales || 0).toString()) === 0
                      ? 'opacity-60'
                      : ''
                  }
                >
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
                  No orders found.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      {/* Pagination */}
      <div className="flex items-center justify-between">
        <div className="text-sm text-muted-foreground">
          Showing {table.getState().pagination.pageIndex * table.getState().pagination.pageSize + 1} to{' '}
          {Math.min(
            (table.getState().pagination.pageIndex + 1) * table.getState().pagination.pageSize,
            table.getFilteredRowModel().rows.length
          )}{' '}
          of {table.getFilteredRowModel().rows.length} orders
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

