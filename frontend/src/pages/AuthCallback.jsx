import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useApp } from '../context/AppContext.jsx';

export default function AuthCallback() {
  const { completeOAuth } = useApp();
  const navigate = useNavigate();
  const [error, setError] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        await completeOAuth();
        navigate('/', { replace: true });
      } catch (err) {
        setError(err.message ?? 'Could not complete sign-in');
      }
    })();
  }, [completeOAuth, navigate]);

  return (
    <div className="flex min-h-screen items-center justify-center">
      {error ? <p className="text-red-600">{error}</p> : <p>Completing sign-in…</p>}
    </div>
  );
}
