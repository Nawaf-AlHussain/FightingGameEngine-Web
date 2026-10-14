/**
 * Root route-change loading screen (Batch 4).
 *
 * WHY: the wipe transition covers the screen, router.push() fires and the
 * wipe sweeps away after 150ms — but if the target route's JS chunk still
 * needs to download, the sweep used to reveal a blank black page for the
 * remainder of the chunk load. This file makes Next render a themed
 * placeholder inside the suspended segment instead, so the wipe reveals a
 * branded loading state rather than nothing. It intentionally uses no
 * client JS and no layout dependencies (renders on the server, animation
 * is pure CSS), so it appears instantly even on a cold chunk fetch.
 */
export default function Loading() {
  return (
    <main
      style={{
        minHeight: '100dvh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '1.25rem',
        background: '#000',
      }}
    >
      <style>{`
        @keyframes fge-loading-pulse {
          0%, 100% { opacity: 0.25; }
          50% { opacity: 1; }
        }
        @keyframes fge-loading-bar {
          0% { transform: translateX(-100%); }
          100% { transform: translateX(250%); }
        }
      `}</style>
      <div
        style={{
          fontFamily: 'var(--font-display)',
          fontSize: '2rem',
          fontWeight: 700,
          letterSpacing: '0.35em',
          color: 'var(--gold, #ffc83d)',
          textShadow: '3px 3px 0 rgba(217, 35, 35, 0.55)',
          animation: 'fge-loading-pulse 1.1s ease-in-out infinite',
          paddingLeft: '0.35em' /* balance the letter-spacing trailing gap */,
        }}
      >
        LOADING
      </div>
      <div
        style={{
          width: 'min(280px, 60vw)',
          height: '3px',
          overflow: 'hidden',
          background: 'rgba(255, 255, 255, 0.08)',
          borderRadius: '2px',
        }}
      >
        <div
          style={{
            width: '40%',
            height: '100%',
            background: 'var(--gold, #ffc83d)',
            animation: 'fge-loading-bar 1.1s ease-in-out infinite',
          }}
        />
      </div>
    </main>
  );
}
