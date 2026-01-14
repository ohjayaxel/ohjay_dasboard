"use client"

import * as React from "react"
import {
  IconBrandGoogle,
  IconBrandMeta,
  IconChartBar,
  IconChartDots,
  IconDashboard,
  IconDatabase,
  IconFileWord,
  IconFolder,
  IconGauge,
  IconHelp,
  IconInnerShadowTop,
  IconListDetails,
  IconReport,
  IconSearch,
  IconSettings,
  IconShoppingCart,
  IconUsers,
  type Icon,
} from "@tabler/icons-react"

import { NavDocuments } from '@/components/nav-documents'
import { NavMain } from '@/components/nav-main'
import { NavSecondary } from '@/components/nav-secondary'
import { NavUser } from '@/components/nav-user'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@/components/ui/sidebar'

type IconKey =
  | 'gauge'
  | 'brand-meta'
  | 'brand-google'
  | 'brand-shopify'
  | 'settings'
  | 'help'
  | 'search'
  | 'chart-dots'
  | 'chart-bar'
  | 'users'
  | 'list-details'

type IconSource = Icon | IconKey

const iconMap: Record<IconKey, Icon> = {
  gauge: IconGauge,
  'brand-meta': IconBrandMeta,
  'brand-google': IconBrandGoogle,
  'brand-shopify': IconShoppingCart,
  settings: IconSettings,
  help: IconHelp,
  search: IconSearch,
  'chart-dots': IconChartDots,
  'chart-bar': IconChartBar,
  users: IconUsers,
  'list-details': IconListDetails,
}

type NavItem = {
  title: string
  url: string
  icon?: IconSource
  items?: NavItem[]
}

type DocumentItem = {
  name: string
  url: string
  icon: IconSource
}

const defaultData = {
  user: {
    name: 'shadcn',
    email: 'm@example.com',
    avatar: '/avatars/shadcn.jpg',
  },
  navMain: [
    {
      title: 'Dashboard',
      url: '/dashboard',
      icon: IconDashboard,
    },
    {
      title: 'Lifecycle',
      url: '#',
      icon: IconListDetails,
    },
    {
      title: 'Analytics',
      url: '#',
      icon: IconChartBar,
    },
    {
      title: 'Projects',
      url: '#',
      icon: IconFolder,
    },
    {
      title: 'Team',
      url: '#',
      icon: IconUsers,
    },
  ] as NavItem[],
  navSecondary: [
    {
      title: 'Settings',
      url: '#',
      icon: IconSettings,
    },
    {
      title: 'Get Help',
      url: '#',
      icon: IconHelp,
    },
    {
      title: 'Search',
      url: '#',
      icon: IconSearch,
    },
  ] as NavItem[],
  documents: [
    {
      name: 'Data Library',
      url: '#',
      icon: IconDatabase,
    },
    {
      name: 'Reports',
      url: '#',
      icon: IconReport,
    },
    {
      name: 'Word Assistant',
      url: '#',
      icon: IconFileWord,
    },
  ] as DocumentItem[],
}

type AppSidebarProps = React.ComponentProps<typeof Sidebar> & {
  tenantName?: string
  navMain?: NavItem[]
  navSecondary?: NavItem[]
  documents?: DocumentItem[]
  user?: {
    name: string
    email: string
    avatar: string
  }
}

export function AppSidebar({
  tenantName,
  navMain,
  navSecondary,
  documents,
  user,
  userTenants,
  ...props
}: AppSidebarProps) {
  const resolveIcon = (icon?: IconSource): Icon | undefined => {
    if (!icon) return undefined
    if (typeof icon === 'string') {
      return iconMap[icon]
    }
    return icon
  }

  const mapNavItems = (items: NavItem[]) =>
    items.map((item) => ({ ...item, icon: resolveIcon(item.icon) }))

  const mapDocuments = (items: DocumentItem[]) =>
    items.map((item) => ({ ...item, icon: resolveIcon(item.icon) ?? IconDatabase }))

  const navMainItems = mapNavItems(navMain ?? defaultData.navMain)
  const navSecondaryItems = mapNavItems(navSecondary ?? defaultData.navSecondary)
  const documentItems = mapDocuments(documents ?? defaultData.documents)
  const sidebarUser = user ?? defaultData.user

  return (
    <Sidebar collapsible="offcanvas" {...props}>
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              asChild
              className="data-[slot=sidebar-menu-button]:!p-1.5"
            >
              <a href={navMainItems[0]?.url ?? '#'}>
                <IconInnerShadowTop className="!size-5" />
                <span className="text-base font-semibold">{tenantName ?? 'Acme Inc.'}</span>
              </a>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <NavMain items={navMainItems} />
        {documentItems.length > 0 ? <NavDocuments items={documentItems} /> : null}
        <NavSecondary items={navSecondaryItems} className="mt-auto" />
      </SidebarContent>
      <SidebarFooter>
        <NavUser user={sidebarUser} userTenants={userTenants} />
      </SidebarFooter>
    </Sidebar>
  )
}
