import { revalidatePath } from 'next/cache'
import { NextRequest, NextResponse } from 'next/server'

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { tenantSlug, path } = body

    if (!tenantSlug) {
      return NextResponse.json({ error: 'tenantSlug is required' }, { status: 400 })
    }

    const paths = path
      ? [path]
      : [
        `/t/${tenantSlug}`,
        `/t/${tenantSlug}/channels`,
        `/t/${tenantSlug}/meta`,
        `/t/${tenantSlug}/google`,
        `/t/${tenantSlug}/markets`,
        `/t/${tenantSlug}/shopify`,
        ]

    for (const p of paths) {
      revalidatePath(p, 'page')
    }

    return NextResponse.json({
      success: true,
      revalidated: paths,
      now: Date.now(),
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

