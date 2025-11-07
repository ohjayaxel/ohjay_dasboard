import type { Metadata } from 'next'
import { Geist, Geist_Mono } from 'next/font/google'
import localFont from 'next/font/local'
import { Analytics } from '@vercel/analytics/next'

import { ThemeProvider } from '@/components/theme-provider'
import { cn } from '@/lib/utils'
import { initSentry } from '@/lib/observability/sentry'

import './globals.css'

const geistSans = Geist({ subsets: ['latin'], variable: '--font-geist-sans' })
const geistMono = Geist_Mono({ subsets: ['latin'], variable: '--font-geist-mono' })
const sentient = localFont({
  src: [
    {
      path: '../public/Sentient-Extralight.woff',
      weight: '300',
      style: 'normal',
    },
    {
      path: '../public/Sentient-LightItalic.woff',
      weight: '300',
      style: 'italic',
    },
  ],
  variable: '--font-sentient',
})

export const metadata: Metadata = {
  title: 'Orange Juice Dashboard',
  description: 'Multi-tenant growth analytics platform',
  icons: {
    icon: '/icon.svg',
  },
}

void initSentry()

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={cn(
          'bg-background text-foreground min-h-screen font-sans antialiased',
          geistSans.variable,
          geistMono.variable,
          sentient.variable,
        )}
      >
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
          {children}
          <Analytics />
        </ThemeProvider>
      </body>
    </html>
  )
}
