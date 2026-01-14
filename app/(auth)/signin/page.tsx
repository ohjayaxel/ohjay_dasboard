'use client'

import Image from 'next/image'
import Link from 'next/link'
import { Suspense, useMemo, useState, useTransition } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'

import { ArrowLeft, Eye, EyeOff, Loader2 } from 'lucide-react'

import { getSupabaseBrowserClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

function getSafeRedirectTarget(searchParams: ReadonlyURLSearchParams): string {
  const redirectParam = searchParams.get('redirect') || searchParams.get('redirectedFrom')
  if (!redirectParam) return '/dashboard'

  // If a full URL is provided, only accept same-origin paths.
  try {
    const asUrl = new URL(redirectParam)
    return `${asUrl.pathname}${asUrl.search}${asUrl.hash}` || '/dashboard'
  } catch {
    // Otherwise accept only internal paths.
    if (redirectParam.startsWith('/')) return redirectParam
    return '/dashboard'
  }
}

function SignInForm() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const redirectTo = useMemo(() => getSafeRedirectTarget(searchParams), [searchParams])

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  const canSubmit = email.trim().length > 0 && password.length > 0 && !isPending

  function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)

    startTransition(async () => {
      try {
        const supabase = getSupabaseBrowserClient()
        const { error: signInError } = await supabase.auth.signInWithPassword({
          email: email.trim(),
          password,
        })

        if (signInError) {
          setError(signInError.message || 'Could not sign in. Please try again.')
          return
        }

        router.replace(redirectTo)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not sign in. Please try again.')
      }
    })
  }

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-background px-4 py-16 sm:px-10">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_15%_15%,rgba(255,140,0,0.14),transparent_55%),radial-gradient(circle_at_80%_10%,rgba(79,70,229,0.12),transparent_45%),radial-gradient(circle_at_bottom,rgba(16,185,129,0.08),transparent_55%)]"
      />
      <div className="relative z-10 flex w-full max-w-3xl flex-col items-center gap-8 rounded-3xl border border-border/40 bg-background/85 px-6 py-10 text-center backdrop-blur sm:px-12 sm:py-16">
        <Link
          href="/"
          className="absolute left-6 top-6 flex items-center gap-2 text-muted-foreground transition-colors hover:text-foreground sm:left-10 sm:top-10"
        >
          <ArrowLeft className="h-4 w-4" />
          <span className="text-sm">Back</span>
        </Link>
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
            Access analytics, dashboards, and advisory notes tailored for your brand. Sign in with your email and password.
          </p>
        </div>

        <form className="flex w-full max-w-md flex-col gap-4 text-left" onSubmit={onSubmit}>
          <div className="space-y-2">
            <Label htmlFor="email">Work email</Label>
            <Input
              id="email"
              type="email"
              placeholder="you@ohjay.co"
              autoComplete="email"
              className="bg-background/70 backdrop-blur"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={isPending}
              required
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="password">Password</Label>
            <div className="relative">
              <Input
                id="password"
                type={showPassword ? 'text' : 'password'}
                placeholder="••••••••"
                autoComplete="current-password"
                className="bg-background/70 pr-10 backdrop-blur"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={isPending}
                required
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="absolute right-1 top-1/2 h-8 w-8 -translate-y-1/2 text-muted-foreground"
                onClick={() => setShowPassword((v) => !v)}
                disabled={isPending || password.length === 0}
                aria-label={showPassword ? 'Hide password' : 'Show password'}
              >
                {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </Button>
            </div>
          </div>

          {error ? (
            <p className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {error}
            </p>
          ) : null}

          <Button type="submit" className="tracking-[0.28em] uppercase" disabled={!canSubmit}>
            {isPending ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Signing in
              </>
            ) : (
              'Sign in'
            )}
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

export default function SignInPage() {
  return (
    <Suspense fallback={<div className="flex min-h-screen items-center justify-center">Loading...</div>}>
      <SignInForm />
    </Suspense>
  )
}

