import { useCallback, useEffect, useState } from 'react';
import { api } from './api.js';
import { ErrorBox, Loading } from './ui.jsx';
import App from './App.jsx';

function Login({ onDone }) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function submit(e) {
    e.preventDefault();
    if (!password) return;
    setBusy(true);
    setError(null);
    try { await api.post('/auth/login', { password }); onDone(); } catch (err) { setError(err); } finally { setBusy(false); }
  }

  return (
    <div className="boot">
      <form className="card login" onSubmit={submit}>
        <h1><span className="brand-mark" aria-hidden="true">✓</span> DayPilot</h1>
        <p className="muted">Sign in to see your meetings and tasks.</p>
        <label className="field">
          <span>Password</span>
          <input type="password" autoComplete="current-password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        {error && <p className="error-text" role="alert">{error.message}</p>}
        <button className="btn btn-primary" type="submit" disabled={busy || !password}>{busy ? 'Signing in…' : 'Sign in'}</button>
      </form>
    </div>
  );
}

export default function AuthGate() {
  const [state, setState] = useState({ loading: true, required: false, authenticated: false, error: null });

  const check = useCallback(async () => {
    try {
      const r = await api.get('/auth/status');
      setState({ loading: false, required: r.required, authenticated: r.authenticated, error: null });
    } catch (error) {
      setState({ loading: false, required: false, authenticated: false, error });
    }
  }, []);

  useEffect(() => {
    check();
    const f = () => setState((s) => ({ ...s, authenticated: false }));
    window.addEventListener('dp-auth-required', f);
    return () => window.removeEventListener('dp-auth-required', f);
  }, [check]);

  const logout = useCallback(async () => {
    try { await api.post('/auth/logout'); } catch { /* ignore */ }
    check();
  }, [check]);

  if (state.loading) return <div className="boot"><h1>DayPilot</h1><Loading /></div>;
  if (state.error) return <div className="boot"><h1>DayPilot</h1><ErrorBox error={state.error} onRetry={check} /></div>;
  if (state.required && !state.authenticated) return <Login onDone={check} />;
  return <App onLogout={state.required ? logout : null} />;
}
