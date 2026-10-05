'use client';

import React from 'react';

/**
 * Shared UI components for the fighting-game frontend.
 *
 * These are the reusable building blocks specified in Section 41 of the
 * FRONTEND_2.1_REDESIGN_SPEC. They provide consistent visual language
 * across all screens:
 *
 * - GameButton: primary/secondary/danger button hierarchy
 * - GamePanel: angular clip-path container
 * - ScreenTitle: large title + subtitle header
 * - LoadingState: contextual loading indicator
 * - ErrorState: error display with retry/back actions
 * - PlayerBadge: P1 (red) / P2 (cyan) identity indicator
 * - DownloadBadge: download status indicator
 */

// ---------------------------------------------------------------------------
// GameButton
// ---------------------------------------------------------------------------

type ButtonVariant = 'primary' | 'secondary' | 'danger';

interface GameButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  loading?: boolean;
}

export function GameButton({
  variant = 'secondary',
  loading = false,
  disabled,
  children,
  className = '',
  ...rest
}: GameButtonProps) {
  const classes = [
    'game-btn',
    `game-btn--${variant}`,
    loading ? 'game-btn--loading' : '',
    disabled ? 'game-btn--disabled' : '',
    className,
  ].filter(Boolean).join(' ');

  return (
    <button
      type="button"
      className={classes}
      disabled={disabled || loading}
      aria-disabled={disabled || loading}
      {...rest}
    >
      {loading ? '…' : children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// GamePanel — angular clip-path container
// ---------------------------------------------------------------------------

interface GamePanelProps extends React.HTMLAttributes<HTMLDivElement> {
  variant?: 'default' | 'p1' | 'p2' | 'warning';
}

export function GamePanel({
  variant = 'default',
  className = '',
  children,
  ...rest
}: GamePanelProps) {
  const classes = [
    'game-panel',
    `game-panel--${variant}`,
    className,
  ].filter(Boolean).join(' ');

  return (
    <div className={classes} {...rest}>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ScreenTitle — large title + subtitle header
// ---------------------------------------------------------------------------

interface ScreenTitleProps {
  title: string;
  subtitle?: string;
  mode?: string;
}

export function ScreenTitle({ title, subtitle, mode }: ScreenTitleProps) {
  return (
    <div className="screen-title">
      {mode && <div className="screen-title__mode">{mode}</div>}
      <h1 className="screen-title__main">{title}</h1>
      {subtitle && <div className="screen-title__sub">{subtitle}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// LoadingState — contextual loading indicator
// ---------------------------------------------------------------------------

interface LoadingStateProps {
  message: string;
}

export function LoadingState({ message }: LoadingStateProps) {
  return (
    <div className="loading-state">
      <div className="loading-state__spinner" />
      <div className="loading-state__message">{message}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ErrorState — error display with retry/back actions
// ---------------------------------------------------------------------------

interface ErrorStateProps {
  title: string;
  message: string;
  onRetry?: () => void;
  onBack?: () => void;
  details?: string;
}

export function ErrorState({ title, message, onRetry, onBack, details }: ErrorStateProps) {
  const [showDetails, setShowDetails] = React.useState(false);
  return (
    <div className="error-state">
      <div className="error-state__icon">⚠</div>
      <h2 className="error-state__title">{title}</h2>
      <p className="error-state__message">{message}</p>
      <div className="error-state__buttons">
        {onRetry && (
          <GameButton variant="primary" onClick={onRetry}>RETRY</GameButton>
        )}
        {onBack && (
          <GameButton variant="secondary" onClick={onBack}>BACK</GameButton>
        )}
      </div>
      {details && (
        <div className="error-state__details">
          <button
            type="button"
            className="error-state__details-toggle"
            onClick={() => setShowDetails(!showDetails)}
          >
            {showDetails ? '▾' : '▸'} Technical Details
          </button>
          {showDetails && (
            <pre className="error-state__details-content">{details}</pre>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// PlayerBadge — P1 (red) / P2 (cyan) identity indicator
// ---------------------------------------------------------------------------

interface PlayerBadgeProps {
  side: 'p1' | 'p2';
  label: string;
  name: string;
  status: string;
  locked?: boolean;
  ai?: boolean;
}

export function PlayerBadge({ side, label, name, status, locked, ai }: PlayerBadgeProps) {
  const classes = [
    'player-badge',
    `player-badge--${side}`,
    locked ? 'player-badge--locked' : '',
  ].filter(Boolean).join(' ');

  return (
    <div className={classes}>
      <div className="player-badge__label">{label}{ai ? ' · CPU' : ''}</div>
      <div className="player-badge__name">{name}</div>
      <div className="player-badge__status">{status}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// DownloadBadge — download status indicator
// ---------------------------------------------------------------------------

type DownloadStatus = 'idle' | 'downloading' | 'cached' | 'error' | 'bundled';

interface DownloadBadgeProps {
  status: DownloadStatus;
  progress?: number;
  sizeMB?: number;
}

export function DownloadBadge({ status, progress, sizeMB }: DownloadBadgeProps) {
  if (status === 'bundled') {
    return <span className="download-badge download-badge--bundled">BUNDLED</span>;
  }
  if (status === 'cached') {
    return <span className="download-badge download-badge--cached">✓ READY</span>;
  }
  if (status === 'downloading') {
    return (
      <span className="download-badge download-badge--downloading">
        DOWNLOADING · {progress ?? 0}%
      </span>
    );
  }
  if (status === 'error') {
    return <span className="download-badge download-badge--error">⚠ FAILED</span>;
  }
  return (
    <span className="download-badge download-badge--idle">
      DOWNLOAD{sizeMB ? ` · ${sizeMB.toFixed(1)} MB` : ''}
    </span>
  );
}
