import Image from 'next/image'
import Link from 'next/link'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

export default function SignInPage() {
  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-background px-4 py-16 sm:px-10">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_15%_15%,rgba(255,140,0,0.14),transparent_55%),radial-gradient(circle_at_80%_10%,rgba(79,70,229,0.12),transparent_45%),radial-gradient(circle_at_bottom,rgba(16,185,129,0.08),transparent_55%)]"
      />
      <div className="relative z-10 flex w-full max-w-3xl flex-col items-center gap-8 rounded-3xl border border-border/40 bg-background/85 px-6 py-10 text-center backdrop-blur sm:px-12 sm:py-16">
        <Link href="/" className="flex items-center gap-3 text-foreground/80">
          <Image
            src="/Orange Juice Logo (3).avif"
            alt="Orange Juice"
            width={160}
            height={48}
            className="h-12 w-auto rounded-md"
          />
        </Link>

        <div className="space-y-3">
          <h1 className="text-3xl font-sentient uppercase tracking-[0.14em] text-foreground sm:text-4xl">
            Sign In
          </h1>
          <p className="mx-auto max-w-md font-mono text-xs text-foreground/70 sm:text-sm">
            Access analytics, dashboards, and advisory notes tailored for your brand. Enter your work email to receive a
            secure magic link.
          </p>
        </div>

        <form className="flex w-full max-w-md flex-col gap-4 text-left">
          <div className="space-y-2">
            <Label htmlFor="email">Work email</Label>
            <Input
              id="email"
              type="email"
              placeholder="you@ohjay.co"
              autoComplete="email"
              className="bg-background/70 backdrop-blur"
            />
          </div>
          <Button type="submit" className="tracking-[0.28em] uppercase">
            Send magic link
          </Button>
        </form>

        <div className="flex flex-col items-center gap-3 text-xs text-muted-foreground sm:flex-row sm:text-sm">
          <span>Need access?</span>
          <Link className="font-mono uppercase tracking-[0.28em] text-primary" href="mailto:hello@ohjay.co">
            hello@ohjay.co
          </Link>
        </div>
      </div>
    </div>
  )
}

