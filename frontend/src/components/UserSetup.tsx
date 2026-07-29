import { useState } from 'react';
import { LogIn, UserPlus, Eye, EyeOff, AlertCircle } from 'lucide-react';
import { api } from '../services/api';

interface Props {
  onSubmit: (name: string) => void;
}

export function UserSetup({ onSubmit }: Props) {
  const [mode, setMode] = useState<'register' | 'login'>('register');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async () => {
    const trimmedUser = username.trim();
    if (!trimmedUser || !password) return;

    setError(null);
    setLoading(true);

    try {
      let result;
      if (mode === 'register') {
        result = await api.register(trimmedUser, password);
      } else {
        result = await api.login(trimmedUser, password);
      }

      if (result.success) {
        onSubmit(trimmedUser);
      } else {
        setError(result.error || 'Authentication failed');
      }
    } catch (e) {
      setError('Connection failed. Make sure the server is running.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{
      height: '100vh',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: '#030712',
      color: 'white',
      padding: '16px',
    }}>
      <div style={{
        width: '100%',
        maxWidth: '400px',
        backgroundColor: '#111827',
        border: '1px solid #1f2937',
        borderRadius: '16px',
        padding: '32px',
      }}>
        {/* Icon */}
        <div style={{
          width: '56px',
          height: '56px',
          borderRadius: '16px',
          background: 'linear-gradient(135deg, #7c3aed, #2563eb)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          margin: '0 auto 16px',
          fontSize: '24px',
        }}>
          🤖
        </div>

        <h1 style={{ fontSize: '24px', fontWeight: 600, textAlign: 'center', marginBottom: '4px' }}>
          {mode === 'register' ? 'Create Account' : 'Welcome Back'}
        </h1>
        <p style={{ color: '#9ca3af', fontSize: '14px', textAlign: 'center', marginBottom: '24px' }}>
          {mode === 'register'
            ? 'Create an account to start chatting with AI.'
            : 'Sign in to continue your conversations.'}
        </p>

        {/* Error message */}
        {error && (
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            padding: '10px 14px',
            backgroundColor: '#450a0a',
            border: '1px solid #991b1b',
            borderRadius: '8px',
            marginBottom: '16px',
            color: '#fca5a5',
            fontSize: '13px',
          }}>
            <AlertCircle size={16} style={{ flexShrink: 0 }} />
            <span>{error}</span>
          </div>
        )}

        {/* Username */}
        <input
          type="text"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !loading) handleSubmit();
          }}
          placeholder="Username"
          autoFocus
          maxLength={24}
          disabled={loading}
          style={{
            width: '100%',
            padding: '12px 16px',
            backgroundColor: '#1f2937',
            border: '1px solid #374151',
            borderRadius: '8px',
            color: 'white',
            fontSize: '16px',
            outline: 'none',
            boxSizing: 'border-box',
            marginBottom: '12px',
            opacity: loading ? 0.6 : 1,
          }}
        />

        {/* Password */}
        <div style={{ position: 'relative', marginBottom: '16px' }}>
          <input
            type={showPassword ? 'text' : 'password'}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !loading) handleSubmit();
            }}
            placeholder="Password (min. 6 characters)"
            maxLength={128}
            disabled={loading}
            style={{
              width: '100%',
              padding: '12px 16px',
              paddingRight: '44px',
              backgroundColor: '#1f2937',
              border: '1px solid #374151',
              borderRadius: '8px',
              color: 'white',
              fontSize: '16px',
              outline: 'none',
              boxSizing: 'border-box',
              opacity: loading ? 0.6 : 1,
            }}
          />
          <button
            type="button"
            onClick={() => setShowPassword(!showPassword)}
            style={{
              position: 'absolute',
              right: '12px',
              top: '50%',
              transform: 'translateY(-50%)',
              background: 'none',
              border: 'none',
              color: '#9ca3af',
              cursor: 'pointer',
              padding: '4px',
            }}
            tabIndex={-1}
          >
            {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
          </button>
        </div>

        {/* Submit button */}
        <button
          type="button"
          onClick={handleSubmit}
          disabled={!username.trim() || !password || loading}
          style={{
            width: '100%',
            padding: '12px',
            backgroundColor: username.trim() && password && !loading ? '#2563eb' : '#374151',
            color: 'white',
            border: 'none',
            borderRadius: '8px',
            fontSize: '16px',
            fontWeight: 500,
            cursor: username.trim() && password && !loading ? 'pointer' : 'not-allowed',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '8px',
            transition: 'background-color 0.2s',
          }}
        >
          {loading ? (
            <span style={{ opacity: 0.7 }}>
              <span style={{ display: 'inline-block', animation: 'spin 1s linear infinite' }}>⟳</span>
              {' '}Please wait...
            </span>
          ) : mode === 'register' ? (
            <>
              <UserPlus size={18} />
              Create Account
            </>
          ) : (
            <>
              <LogIn size={18} />
              Sign In
            </>
          )}
        </button>

        {/* Toggle mode */}
        <div style={{ textAlign: 'center', marginTop: '20px' }}>
          <button
            type="button"
            onClick={() => {
              setMode(mode === 'register' ? 'login' : 'register');
              setError(null);
            }}
            style={{
              background: 'none',
              border: 'none',
              color: '#60a5fa',
              fontSize: '14px',
              cursor: 'pointer',
              textDecoration: 'underline',
              padding: '4px',
            }}
          >
            {mode === 'register' ? 'Already have an account? Sign in' : "Don't have an account? Create one"}
          </button>
        </div>
      </div>
    </div>
  );
}
