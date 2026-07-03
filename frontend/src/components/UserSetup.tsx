import { useState } from 'react';
import { User } from 'lucide-react';

interface Props {
  onSubmit: (name: string) => void;
}

export function UserSetup({ onSubmit }: Props) {
  const [name, setName] = useState('');

  const go = () => {
    alert('Button clicked! Name: ' + name);
    if (name.trim()) {
      onSubmit(name.trim());
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
        <h1 style={{ fontSize: '24px', fontWeight: 600, textAlign: 'center', marginBottom: '8px' }}>
          Welcome
        </h1>
        <p style={{ color: '#9ca3af', fontSize: '14px', textAlign: 'center', marginBottom: '24px' }}>
          Pick a name to keep your chats separate.
        </p>

        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') go();
          }}
          placeholder="Your name"
          autoFocus
          maxLength={24}
          style={{
            width: '100%',
            padding: '12px 16px',
            backgroundColor: '#1f2937',
            border: '1px solid #374151',
            borderRadius: '8px',
            color: 'white',
            fontSize: '18px',
            textAlign: 'center',
            outline: 'none',
            boxSizing: 'border-box',
          }}
        />

        <button
          type="button"
          onClick={go}
          style={{
            width: '100%',
            marginTop: '16px',
            padding: '12px',
            backgroundColor: name.trim() ? '#2563eb' : '#374151',
            color: 'white',
            border: 'none',
            borderRadius: '8px',
            fontSize: '16px',
            fontWeight: 500,
            cursor: name.trim() ? 'pointer' : 'not-allowed',
          }}
        >
          Continue
        </button>
      </div>
    </div>
  );
}
