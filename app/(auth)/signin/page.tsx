export default function SignInPage() {
  return (
    <div className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center gap-6 px-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Sign in to Orange Juice</h1>
        <p className="text-sm text-muted-foreground">
          Magic-link authentication via Supabase will be added here.
        </p>
      </div>

      <div className="rounded-lg border p-6">
        <p className="text-sm text-muted-foreground">
          TODO: Replace with Supabase Auth component and magic link handler.
        </p>
      </div>
    </div>
  );
}

