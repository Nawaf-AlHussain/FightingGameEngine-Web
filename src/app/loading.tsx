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
 *
 * Comic overhaul: Anton poster voice, cream paper on ink with a crimson
 * misregistration shadow, and a striped racing bar as the progress pulse.
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
        gap: '1.4rem',
        background: 'var(--ink, #101018)',
      }}
    >
      <style>{`
        @keyframes fge-loading-pulse {
          0%, 100% { opacity: 0.35; }
          50% { opacity: 1; }
        }
        @keyframes fge-loading-bar {
          0% { transform: translateX(-100%); }
          100% { transform: translateX(250%); }
        }
      `}</style>
      <div
        style={{
          fontFamily: 'var(--font-poster, Anton, sans-serif)',
          fontSize: '2.4rem',
          fontWeight: 400,
          letterSpacing: '0.12em',
          paddingLeft: '0.12em',
          color: 'var(--paper, #f2ecda)',
          textShadow: '4px 4px 0 var(--crimson, #e8283c)',
          animation: 'fge-loading-pulse 1.1s ease-in-out infinite',
          lineHeight: 1,
        }}
      >
        LOADING
      </div>
      <div
        style={{
          width: 'min(280px, 60vw)',
          height: '6px',
          overflow: 'hidden',
          background: 'rgba(242, 236, 218, 0.12)',
          border: '1px solid rgba(242, 236, 218, 0.25)',
        }}
      >
        <div
          style={{
            width: '40%',
            height: '100%',
            background: 'repeating-linear-gradient(90deg, var(--crimson, #e8283c) 0 10px, var(--paper, #f2ecda) 10px 20px)',
            animation: 'fge-loading-bar 1.1s ease-in-out infinite',
          }}
        />
      </div>
    </main>
  );
}
