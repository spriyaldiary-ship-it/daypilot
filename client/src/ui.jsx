import { useCallback, useEffect, useRef, useState } from 'react';

export function useAsync(fn, deps) {
  const [state, setState] = useState({ loading: true, data: null, error: null });
  const seq = useRef(0);
  const run = useCallback(async () => {
    const id = ++seq.current;
    setState((p) => ({ ...p, loading: true, error: null }));
    try {
      const data = await fn();
      if (id === seq.current) setState({ loading: false, data, error: null });
    } catch (error) {
      if (id === seq.current) setState((p) => ({ loading: false, data: p.data, error }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => { run(); }, [run]);
  return { ...state, reload: run };
}

export function Loading({ label = 'Loading…' }) {
  return (
    <div className="loading" role="status" aria-live="polite">
      <div className="skeleton" style={{ width: '40%', height: 28 }} />
      <div className="skeleton" style={{ width: '100%', height: 90 }} />
      <div className="skeleton" style={{ width: '100%', height: 140 }} />
      <span className="sr-only">{label}</span>
    </div>
  );
}

export function ErrorBox({ error, onRetry }) {
  if (!error) return null;
  return (
    <div className="alert alert-danger" role="alert">
      <div>
        <strong>Something went wrong.</strong> {error.message}
      </div>
      {onRetry && <button className="btn btn-small" onClick={onRetry}>Try again</button>}
    </div>
  );
}

export function Empty({ title, hint, action }) {
  return (
    <div className="empty">
      <div className="empty-title">{title}</div>
      {hint && <p>{hint}</p>}
      {action}
    </div>
  );
}

export function Badge({ tone = 'neutral', children, title }) {
  return <span className={`badge badge-${tone}`} title={title}>{children}</span>;
}

export function Field({ label, error, hint, children, className = '' }) {
  return (
    <label className={`field ${className}`}>
      <span className="field-label">{label}</span>
      {children}
      {hint && !error && <span className="field-hint">{hint}</span>}
      {error && <span className="field-error" role="alert">{error}</span>}
    </label>
  );
}

export function Modal({ title, onClose, children, wide = false, role = 'dialog' }) {
  const ref = useRef(null);
  useEffect(() => {
    const previous = document.activeElement;
    const el = ref.current;
    const focusable = el.querySelector('input, select, textarea, button');
    (focusable || el).focus();
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose(); }
      if (e.key === 'Tab') {
        const nodes = [...el.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled])')];
        if (!nodes.length) return;
        const first = nodes[0], last = nodes[nodes.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
      if (previous && previous.focus) previous.focus();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`modal ${wide ? 'modal-wide' : ''}`} role={role} aria-modal="true" aria-label={title} ref={ref} tabIndex={-1}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="btn btn-ghost btn-icon" onClick={onClose} aria-label="Close dialog">✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Page({ title, subtitle, actions, children }) {
  return (
    <section className="page">
      <header className="page-head">
        <div>
          <h1>{title}</h1>
          {subtitle && <p className="muted">{subtitle}</p>}
        </div>
        {actions && <div className="page-actions">{actions}</div>}
      </header>
      {children}
    </section>
  );
}

export function Card({ title, aside, children, tone, className = '' }) {
  return (
    <section className={`card ${tone ? `card-${tone}` : ''} ${className}`}>
      {(title || aside) && (
        <header className="card-head">
          {title && <h2>{title}</h2>}
          {aside && <div className="card-aside">{aside}</div>}
        </header>
      )}
      {children}
    </section>
  );
}
