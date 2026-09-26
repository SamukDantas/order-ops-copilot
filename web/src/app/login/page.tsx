import { signIn } from "./actions";

export default async function LoginPage(props: PageProps<"/login">) {
  const { error } = await props.searchParams;
  return (
    <main className="flex flex-1 items-center justify-center p-6">
      <form action={signIn} className="w-full max-w-sm space-y-4 rounded-xl border border-border bg-surface p-6">
        <div>
          <h1 className="text-lg font-semibold">Order Ops Copilot</h1>
          <p className="text-sm text-muted">Sign in to review personalised orders.</p>
        </div>
        <label className="block text-sm">
          Email
          <input name="email" type="email" required autoComplete="email"
            className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2" />
        </label>
        <label className="block text-sm">
          Password
          <input name="password" type="password" required autoComplete="current-password"
            className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2" />
        </label>
        {error && <p className="text-sm text-bad">Invalid email or password.</p>}
        <button className="w-full rounded-md bg-accent px-3 py-2 text-sm font-medium text-white dark:text-black">
          Sign in
        </button>
      </form>
    </main>
  );
}
