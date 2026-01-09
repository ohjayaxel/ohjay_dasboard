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
  order_number?: number | null
  processed_at: string | null
  created_at?: string | null
  created_at_ts?: string | null
  updated_at?: string | null
  total_sales: number | null
  tax: number | null
  total_tax: number | null
  gross_sales: number | null
  net_sales: number | null
  revenue: number | null
  // Backwards compatibility: older schema used discount_total/total_refunds.
  // Current schema (migration 041) uses discount/refunds.
  discount?: number | null
  refunds?: number | null
  discount_total?: number | null
  total_refunds?: number | null
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
  dateField?: 'processed_at' | 'created_at' | 'created_at_ts' | 'updated_at'
  idField?: 'order_id' | 'order_number'
  groupBy?: 'date_order' | 'date' | 'order'
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

const getDiscountValue = (order: ShopifyOrder) =>
  getNumericValue(order.discount ?? order.discount_total)

const getRefundsValue = (order: ShopifyOrder) =>
  getNumericValue(order.refunds ?? order.total_refunds)

const formatDate = (date: string | null) => {
  if (!date) return '—'
  return new Date(date).toLocaleDateString('sv-SE')
}

const formatDateTime = (date: string | null) => {
  if (!date) return '—'
  return new Date(date).toLocaleString('sv-SE')
}

function toStockholmDay(date: string | null): string | null {
  if (!date) return null
  try {
    return new Date(date).toLocaleDateString('en-CA', { timeZone: 'Europe/Stockholm' })
  } catch {
    return null
  }
}

function getGroupDay(order: ShopifyOrder, dateField: NonNullable<OrdersTableProps['dateField']>): string | null {
  const raw = (order as any)[dateField] as string | null | undefined
  return toStockholmDay(raw ?? null)
}

type GroupedRow = ShopifyOrder & {
  // For aggregated rows, these help keep the UI consistent.
  _group_key: string
  _group_count: number
}

function groupOrders(
  orders: ShopifyOrder[],
  opts: {
    groupBy: NonNullable<OrdersTableProps['groupBy']>
    dateField: NonNullable<OrdersTableProps['dateField']>
    idField: NonNullable<OrdersTableProps['idField']>
  },
): GroupedRow[] {
  const { groupBy, dateField, idField } = opts

  // Default behavior: show raw order rows (date+order).
  if (groupBy === 'date_order') {
    return orders.map((o) => ({
      ...o,
      _group_key: `${(o as any)[idField] ?? o.order_id}-${(o as any)[dateField] ?? ''}`,
      _group_count: 1,
    }))
  }

  const groups = new Map<string, GroupedRow>()

  for (const o of orders) {
    const day = getGroupDay(o, dateField)
    const idVal = (o as any)[idField] ?? o.order_id

    const key =
      groupBy === 'date'
        ? `date:${day ?? '—'}`
        : `order:${idVal ?? '—'}`

    const existing = groups.get(key)
    if (!existing) {
      groups.set(key, {
        ...o,
        // For date-only grouping, keep the chosen date field (as a day string) and blank the ID dimension.
        ...(groupBy === 'date'
          ? {
              // Keep all date-ish fields aligned for display/filtering.
              processed_at: day ?? null,
              created_at: day ?? null,
              created_at_ts: null,
              updated_at: null,
              // Remove order identifiers so we don't "slice" on them.
              order_id: '—',
              order_number: null,
            }
          : {}),
        _group_key: key,
        _group_count: 1,
      })
      continue
    }

    // Aggregate numerics
    existing.gross_sales = getNumericValue(existing.gross_sales) + getNumericValue(o.gross_sales)
    existing.net_sales = getNumericValue(existing.net_sales) + getNumericValue(o.net_sales)
    existing.total_tax = getNumericValue(existing.total_tax) + getNumericValue(o.total_tax)
    existing.tax = getNumericValue(existing.tax) + getNumericValue(o.tax)
    existing.total_sales =
      getNumericValue(existing.total_sales) + getNumericValue(o.total_sales)
    existing.revenue = getNumericValue(existing.revenue) + getNumericValue(o.revenue)

    // Backcompat fields
    const existingDiscount = getDiscountValue(existing)
    const nextDiscount = getDiscountValue(o)
    existing.discount = existingDiscount + nextDiscount

    const existingRefunds = getRefundsValue(existing)
    const nextRefunds = getRefundsValue(o)
    existing.refunds = existingRefunds + nextRefunds

    existing._group_count += 1
    groups.set(key, existing)
  }

  return Array.from(groups.values())
}

export function OrdersTable({ orders, from, to, tenantSlug, dateField: dateFieldProp, idField: idFieldProp, groupBy: groupByProp }: OrdersTableProps) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [sorting, setSorting] = React.useState<SortingState>([])
  const [globalFilter, setGlobalFilter] = React.useState('')

  const dateField =
    dateFieldProp ??
    ((searchParams.get('dateField') as OrdersTableProps['dateField']) ?? 'processed_at')
  const idField =
    idFieldProp ?? ((searchParams.get('idField') as OrdersTableProps['idField']) ?? 'order_id')
  const groupBy =
    groupByProp ?? ((searchParams.get('groupBy') as OrdersTableProps['groupBy']) ?? 'date_order')

  const setQueryParam = (key: string, value: string) => {
    const params = new URLSearchParams(searchParams.toString())
    params.set(key, value)
    // Support both tenant context and admin context
    const isAdminContext =
      typeof window !== 'undefined' &&
      window.location.pathname.includes('/admin/audits/orders')
    if (isAdminContext) {
      const tenant = searchParams.get('tenant')
      if (tenant) params.set('tenant', tenant)
      router.push(`/admin/audits/orders?${params.toString()}`)
    } else if (tenantSlug) {
      router.push(`/t/${tenantSlug}/shopify/orders?${params.toString()}`)
    }
  }

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
  const displayRows = React.useMemo(
    () =>
      groupOrders(orders, {
        groupBy: (groupBy as any) || 'date_order',
        dateField: (dateField as any) || 'processed_at',
        idField: (idField as any) || 'order_id',
      }),
    [orders, groupBy, dateField, idField],
  )

  const includedOrders = displayRows.filter((o) => parseFloat((o.gross_sales || 0).toString()) > 0)
  const excludedOrders = displayRows.filter((o) => parseFloat((o.gross_sales || 0).toString()) === 0)

  const columns: ColumnDef<ShopifyOrder>[] = React.useMemo(
    () => {
      const cols: ColumnDef<ShopifyOrder>[] = []

      // Grouping toggle controls whether we include these dimensions as columns.
      if (groupBy === 'date_order' || groupBy === 'order') {
        cols.push({
          accessorKey: idField,
          header: idField === 'order_number' ? 'Order Number' : 'Order ID',
          cell: ({ row }) => (
            <div className="font-mono text-sm">{row.getValue(idField) ?? '—'}</div>
          ),
        })
      }

      if (groupBy === 'date_order' || groupBy === 'date') {
        cols.push({
          accessorKey: dateField,
          header:
            dateField === 'created_at'
              ? 'Created Date'
              : dateField === 'created_at_ts'
                ? 'Created At'
                : dateField === 'updated_at'
                  ? 'Updated At'
                  : 'Processed Date',
          cell: ({ row }) => {
            const raw = row.getValue(dateField) as string | null
            return dateField === 'created_at_ts' || dateField === 'updated_at'
              ? formatDateTime(raw)
              : formatDate(raw)
          },
        })
      }

      cols.push(
      {
        id: 'total_sales',
        header: 'Total Sales',
        accessorFn: (row) => {
          const grossSales = getNumericValue(row.gross_sales)
          const tax = getNumericValue(row.total_tax)
          return grossSales + tax
        },
        cell: ({ row }) => {
          const grossSales = getNumericValue(row.original.gross_sales)
          const tax = getNumericValue(row.original.total_tax)
          const totalSales = grossSales + tax
          const currency = row.original.currency || 'SEK'
          return (
            <div className={totalSales > 0 ? 'font-medium' : 'text-muted-foreground'}>
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
        accessorKey: 'gross_sales',
        header: 'Gross Sales',
        cell: ({ row }) => {
          const grossSales = row.getValue('gross_sales') as number | null
          const currency = row.original.currency || 'SEK'
          return (
            <div className={grossSales && grossSales > 0 ? 'font-medium' : 'text-muted-foreground'}>
              {formatCurrency(grossSales, currency)}
            </div>
          )
        },
      },
      {
        id: 'discount',
        header: 'Discounts',
        cell: ({ row }) => {
          const discount = getDiscountValue(row.original)
          const currency = row.original.currency || 'SEK'
          return (
            <div className="text-muted-foreground">
              {formatCurrency(discount, currency)}
            </div>
          )
        },
      },
      {
        id: 'refunds',
        header: 'Returns',
        cell: ({ row }) => {
          const refunds = getRefundsValue(row.original)
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
      )

      return cols
    },
    [dateField, idField, groupBy]
  )

  const table = useReactTable({
    data: displayRows,
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
  // Total Sales = gross_sales + tax (or use total_sales directly if available)
  const totalSalesSum = includedOrders.reduce((sum, order) => {
    return sum + getNumericValue(order.total_sales ?? (order.gross_sales && order.tax ? order.gross_sales + order.tax : null))
  }, 0)

  // Gross Sales = gross_sales (exklusive skatt)
  const totalGrossSales = includedOrders.reduce((sum, order) => {
    return sum + getNumericValue(order.gross_sales)
  }, 0)

  const totalNetSales = includedOrders.reduce((sum, order) => {
    return sum + getNumericValue(order.net_sales)
  }, 0)

  // Calculate totals for Tax, Discounts, and Returns
  const totalTax = includedOrders.reduce((sum, order) => {
    return sum + getNumericValue(order.total_tax)
  }, 0)

  const totalDiscounts = includedOrders.reduce((sum, order) => {
    return sum + getDiscountValue(order)
  }, 0)

  const totalReturns = includedOrders.reduce((sum, order) => {
    return sum + getRefundsValue(order)
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

        <div className="flex items-center gap-2">
          <label className="text-sm font-medium">Date field:</label>
          <Select
            value={dateField ?? 'processed_at'}
            onValueChange={(value) => setQueryParam('dateField', value)}
          >
            <SelectTrigger className="w-[180px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="processed_at">processed_at (report day)</SelectItem>
              <SelectItem value="created_at">created_at (date)</SelectItem>
              <SelectItem value="created_at_ts">created_at_ts (timestamp)</SelectItem>
              <SelectItem value="updated_at">updated_at (timestamp)</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="flex items-center gap-2">
          <label className="text-sm font-medium">ID field:</label>
          <Select
            value={idField ?? 'order_id'}
            onValueChange={(value) => setQueryParam('idField', value)}
          >
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
          <Select value={groupBy ?? 'date_order'} onValueChange={(value) => setQueryParam('groupBy', value)}>
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

      {/* Summary */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-7">
        <div className="rounded-lg border p-4">
          <div className="text-sm text-muted-foreground">Included Orders</div>
          <div className="text-2xl font-semibold">{includedOrders.length}</div>
        </div>
        <div className="rounded-lg border p-4">
          <div className="text-sm font-medium text-muted-foreground">Total Sales</div>
          <div className="text-2xl font-semibold">{formatCurrency(totalSalesSum)}</div>
          <p className="mt-1 text-xs text-muted-foreground">
            Gross Sales plus collected tax.
          </p>
        </div>
        <div className="rounded-lg border p-4">
          <div className="text-sm font-medium text-muted-foreground">Gross Sales</div>
          <div className="text-2xl font-semibold">{formatCurrency(totalGrossSales)}</div>
          <p className="mt-1 text-xs text-muted-foreground">Produkter före rabatter, exklusive skatt.</p>
        </div>
        <div className="rounded-lg border p-4">
          <div className="text-sm font-medium text-muted-foreground">Tax</div>
          <div className="text-2xl font-semibold">{formatCurrency(totalTax)}</div>
          <p className="mt-1 text-xs text-muted-foreground">
            Total tax collected.
          </p>
        </div>
        <div className="rounded-lg border p-4">
          <div className="text-sm font-medium text-muted-foreground">Discounts</div>
          <div className="text-2xl font-semibold">{formatCurrency(totalDiscounts)}</div>
          <p className="mt-1 text-xs text-muted-foreground">
            Total discounts applied.
          </p>
        </div>
        <div className="rounded-lg border p-4">
          <div className="text-sm font-medium text-muted-foreground">Returns</div>
          <div className="text-2xl font-semibold">{formatCurrency(totalReturns)}</div>
          <p className="mt-1 text-xs text-muted-foreground">
            Total refunds/returns.
          </p>
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

