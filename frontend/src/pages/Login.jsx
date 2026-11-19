/** Login screen. */
import { useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useApp } from '../context/AppContext.jsx';
import { Button, Input, Alert } from '../components/ui.jsx';

export default function Login() {
  const { signIn, signInWithGoogle, user, booting, toast } = useApp();
  const navigate = useNavigate();
  const location = useLocation();
  const [form, setForm] = useState({ email: '', password: '' });
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  if (!booting && user) return <Navigate to={location.state?.from ?? '/'} replace />;

  const onSubmit = async (event) => {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await signIn(form.email.trim(), form.password);
      navigate('/', { replace: true });
    } catch (submitError) {
      setError(submitError.message ?? 'Could not sign in');
      toast(submitError.message ?? 'Could not sign in', 'error');
    } finally {
      setSubmitting(false);
    }
  };

  const useDemo = () => setForm({ email: 'demo@socialhub.test', password: 'Demo1234!' });

  return (
    <div className="flex min-h-screen">
      {/* Marketing panel - hidden on small screens so the form gets the space. */}
      <div className="hidden w-1/2 flex-col justify-between bg-slate-900 p-10 lg:flex">
        <div className="flex items-center gap-3 text-white">
          <img src="/socialhub-icon.png" alt="" className="h-11 w-11 shrink-0 rounded-xl object-contain" />
          <span className="text-xl font-semibold tracking-tight">SocialHub</span>
        </div>

        <div className="max-w-md">
          <h1 className="text-3xl font-semibold leading-tight text-white">
            Every customer conversation in one inbox.
          </h1>
          <p className="mt-4 text-sm leading-relaxed text-slate-400">
            Website chat, Facebook Messenger and Instagram land in the same thread list. An AI assistant
            answers what it can and hands the rest to you.
          </p>
          <ul className="mt-8 space-y-2.5 text-sm text-slate-400">
            <li>· One inbox across every channel</li>
            <li>· FAQ-trained assistant that escalates instead of guessing</li>
            <li>· Response-time and AI-resolution analytics</li>
          </ul>
        </div>

        <p className="text-xs text-slate-600">Final year project · React + Express + MariaDB</p>
      </div>

      {/* Form */}
      <div className="flex w-full items-center justify-center bg-white p-6 lg:w-1/2">
        <form onSubmit={onSubmit} className="w-full max-w-sm">
          <div className="mb-8 lg:hidden">
            <img src="/socialhub-icon.png" alt="SocialHub" className="h-12 w-12 rounded-lg object-contain" />
          </div>

          <h2 className="text-xl font-semibold text-slate-900">Sign in</h2>
          <p className="mt-1 text-sm text-slate-500">Use your SocialHub account.</p>

          {error && (
            <Alert tone="error" className="mt-5">
              {error}
            </Alert>
          )}

          <div className="mt-6 space-y-4">
            <Input
              label="Email"
              type="email"
              autoComplete="email"
              required
              value={form.email}
              onChange={(event) => setForm({ ...form, email: event.target.value })}
              placeholder="you@company.com"
            />
            <Input
              label="Password"
              type="password"
              autoComplete="current-password"
              required
              value={form.password}
              onChange={(event) => setForm({ ...form, password: event.target.value })}
              placeholder="••••••••"
            />
          </div>

          <Button type="submit" loading={submitting} className="mt-6 w-full">
            Sign in
          </Button>

          <Button
            type="button"
            variant="secondary"
            className="mt-3 w-full"
            onClick={() => signInWithGoogle().catch((e) => toast(e.message ?? 'Google sign-in failed', 'error'))}
          >
            Continue with Google
          </Button>

          <div className="mt-6 rounded-lg bg-slate-50 p-3 text-xs text-slate-600">
            <p className="font-medium text-slate-700">Demo workspace</p>
            <p className="mt-0.5">demo@socialhub.test / Demo1234!</p>
            <button type="button" onClick={useDemo} className="mt-1.5 font-medium text-brand-700 hover:underline">
              Fill it in
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
