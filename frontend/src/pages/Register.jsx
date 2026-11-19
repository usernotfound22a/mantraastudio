/** Register: creates the account AND its first workspace in one step. */
import { useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { api, tokens, setActiveWorkspaceId } from '../lib/api.js';
import { useApp } from '../context/AppContext.jsx';
import { Button, Input, Alert } from '../components/ui.jsx';

export default function Register() {
  const { user, booting, signIn } = useApp();
  const navigate = useNavigate();
  const [form, setForm] = useState({
    fullName: '',
    email: '',
    password: '',
    workspaceName: '',
  });
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  if (!booting && user) return <Navigate to="/" replace />;

  const onSubmit = async (event) => {
    event.preventDefault();
    setError(null);
    setNotice(null);
    setSubmitting(true);
    try {
      // Register creates the user, their first workspace and an owner
      // membership in one call.
      const data = await api.post(
        '/auth/register',
        {
          fullName: form.fullName.trim(),
          email: form.email.trim(),
          password: form.password,
          workspaceName: form.workspaceName.trim(),
        },
        { auth: false },
      );

      if (data.confirmationRequired) {
        setNotice(data.message || `Check ${data.email} to confirm your email, then sign in.`);
        return;
      }

      tokens.save({
        accessToken: data.tokens?.accessToken ?? data.accessToken,
        refreshToken: data.tokens?.refreshToken,
        user: data.user,
      });
      setActiveWorkspaceId(data.workspaces?.[0]?.id ?? null);

      // Re-use the login path so every context (socket, workspace) is set up
      // exactly once, in one place.
      await signIn(form.email.trim(), form.password);
      navigate('/', { replace: true });
    } catch (submitError) {
      setError(submitError.message ?? 'Could not create the account');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 p-6">
      <div className="w-full max-w-md">
        <div className="mb-6 flex items-center justify-center gap-3">
          <img src="/socialhub-icon.png" alt="" className="h-11 w-11 shrink-0 rounded-xl object-contain" />
          <span className="text-xl font-semibold tracking-tight text-slate-900">Mantraa Studio</span>
        </div>

        <div className="card p-6">
          <h1 className="text-lg font-semibold text-slate-900">Create your workspace</h1>
          <p className="mt-1 text-sm text-slate-500">You become the owner, so you can invite agents later.</p>

          {error && (
            <Alert tone="error" className="mt-5">
              {error}
            </Alert>
          )}
          {notice && (
            <Alert tone="info" className="mt-5">
              {notice}
            </Alert>
          )}

          <form onSubmit={onSubmit} className="mt-5 space-y-4">
            <Input
              label="Your name"
              required
              value={form.fullName}
              onChange={(event) => setForm({ ...form, fullName: event.target.value })}
              placeholder="Alex Morgan"
            />
            <Input
              label="Work email"
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
              autoComplete="new-password"
              required
              minLength={8}
              value={form.password}
              onChange={(event) => setForm({ ...form, password: event.target.value })}
              hint="At least 8 characters."
            />
            <Input
              label="Workspace name"
              required
              value={form.workspaceName}
              onChange={(event) => setForm({ ...form, workspaceName: event.target.value })}
              placeholder="Acme Support"
            />

            <Button type="submit" loading={submitting} className="w-full">
              Create workspace
            </Button>
          </form>
        </div>

        <p className="mt-4 text-center text-sm text-slate-600">
          Already have an account?{' '}
          <Link to="/login" className="font-medium text-brand-700 hover:underline">
            Sign in
          </Link>
        </p>
      </div>
    </div>
  );
}
