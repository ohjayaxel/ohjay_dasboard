"use client"

import * as React from "react"
import {
  ColumnDef,
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  SortingState,
  useReactTable,
} from "@tanstack/react-table"
import { ArrowUpDown } from "lucide-react"

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Button } from "@/components/ui/button"
import type { KpiSeriesPoint } from "@/lib/data/agg"

type GoogleTableProps = {
  data: KpiSeriesPoint[]
  currencyCode: string
  numberLocale: string
}

const STORAGE_KEY = 'google-table-sorting'

export function GoogleTable({
  data,
  currencyCode,
  numberLocale,
}: GoogleTableProps) {
  // Load initial sorting from localStorage, default to date descending
  const [sorting, setSorting] = React.useState<SortingState>(() => {
    if (typeof window === 'undefined') {
      return [{ id: 'date', desc: true }] // Default: latest date first
    }
    try {
      const saved = localStorage.getItem(STORAGE_KEY)
      if (saved) {
        return JSON.parse(saved)
      }
    } catch {
      // Ignore parse errors
    }
    return [{ id: 'date', desc: true }] // Default: latest date first
  })

  // Save sorting to localStorage whenever it changes
  React.useEffect(() => {
    if (typeof window !== 'undefined') {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(sorting))
      } catch {
        // Ignore storage errors
      }
    }
  }, [sorting])

  const formatCurrency = React.useCallback((value: number | null) => {
    return value !== null && Number.isFinite(value)
      ? new Intl.NumberFormat(numberLocale, {
          style: 'currency',
          currency: currencyCode,
          maximumFractionDigits: 0,
        }).format(value)
      : '—'
  }, [currencyCode, numberLocale])

  const formatNumber = React.useCallback((value: number | null) => {
    return value !== null && Number.isFinite(value)
      ? new Intl.NumberFormat(numberLocale).format(value)
      : '0'
  }, [numberLocale])

  const formatRatio = React.useCallback((value: number | null) => {
    return value === null || Number.isNaN(value) ? '—' : value.toFixed(2)
  }, [])

  const columns: ColumnDef<KpiSeriesPoint>[] = React.useMemo(
    () => [
      {
        accessorKey: "date",
        header: ({ column }) => {
          return (
            <Button
              variant="ghost"
              onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
              className="h-8 px-2 lg:px-3"
            >
              Date
              <ArrowUpDown className="ml-2 h-4 w-4" />
            </Button>
          )
        },
        cell: ({ row }) => <div className="font-medium">{row.getValue("date")}</div>,
      },
      {
        accessorKey: "spend",
        header: ({ column }) => {
          return (
            <Button
              variant="ghost"
              onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
              className="h-8 px-2 lg:px-3"
            >
              Spend
              <ArrowUpDown className="ml-2 h-4 w-4" />
            </Button>
          )
        },
        cell: ({ row }) => formatCurrency(row.getValue("spend")),
      },
      {
        accessorKey: "revenue",
        header: ({ column }) => {
          return (
            <Button
              variant="ghost"
              onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
              className="h-8 px-2 lg:px-3"
            >
              Revenue
              <ArrowUpDown className="ml-2 h-4 w-4" />
            </Button>
          )
        },
        cell: ({ row }) => formatCurrency(row.getValue("revenue")),
      },
      {
        accessorKey: "conversions",
        header: ({ column }) => {
          return (
            <Button
              variant="ghost"
              onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
              className="h-8 px-2 lg:px-3"
            >
              Conversions
              <ArrowUpDown className="ml-2 h-4 w-4" />
            </Button>
          )
        },
        cell: ({ row }) => formatNumber(row.getValue("conversions")),
      },
      {
        accessorKey: "roas",
        header: ({ column }) => {
          return (
            <Button
              variant="ghost"
              onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
              className="h-8 px-2 lg:px-3"
            >
              ROAS
              <ArrowUpDown className="ml-2 h-4 w-4" />
            </Button>
          )
        },
        cell: ({ row }) => formatRatio(row.getValue("roas")),
      },
    ],
    [formatCurrency, formatNumber, formatRatio]
  )

  const table = useReactTable({
    data,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    onSortingChange: setSorting,
    state: {
      sorting,
    },
    initialState: {
      sorting: [{ id: 'date', desc: true }], // Default: latest date first
    },
  })

  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          {table.getHeaderGroups().map((headerGroup) => (
            <TableRow key={headerGroup.id}>
              {headerGroup.headers.map((header) => {
                return (
                  <TableHead key={header.id}>
                    {header.isPlaceholder
                      ? null
                      : flexRender(header.column.columnDef.header, header.getContext())}
                  </TableHead>
                )
              })}
            </TableRow>
          ))}
        </TableHeader>
        <TableBody>
          {table.getRowModel().rows?.length ? (
            table.getRowModel().rows.map((row) => (
              <TableRow key={row.id} data-state={row.getIsSelected() && "selected"}>
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
                No Google Ads KPI data available.
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  )
}

