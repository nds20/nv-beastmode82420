import { useState } from 'react';

// A password input with a show/hide eye toggle — shared by the admin
// sign-in and the admin password-recovery page so the owner can SEE
// what he is typing (a mistyped password is invisible by default,
// which is how lockouts happen).
//
// The value is fully controlled by the parent: flipping the toggle
// only changes the input's type between 'password' and 'text' — it
// never clears or alters the value. The toggle is a real <button>
// with type="button", so it can never submit the surrounding form,
// and it is keyboard-reachable with an aria-label naming the action
// ("Show password" / "Hide password" by default; the recovery page
// passes its own labels for the recovery-code field).
export default function PasswordField({
  id,
  label,
  value,
  onChange,
  autoComplete = 'current-password',
  required = false,
  showLabel = 'Show password',
  hideLabel = 'Hide password',
}) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <div className="password-field">
        <input
          id={id}
          type={visible ? 'text' : 'password'}
          autoComplete={autoComplete}
          value={value}
          onChange={onChange}
          required={required}
        />
        <button
          type="button"
          className="password-toggle"
          onClick={() => setVisible((v) => !v)}
          aria-label={visible ? hideLabel : showLabel}
          aria-pressed={visible}
        >
          {visible ? 'Hide' : 'Show'}
        </button>
      </div>
    </div>
  );
}
