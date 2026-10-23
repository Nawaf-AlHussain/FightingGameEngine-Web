import { NextResponse } from 'next/server';

/**
 * /settings — DISABLED for the public showcase build (FINDINGS F-041).
 *
 * A route handler (not a page) so every request is bounced to /lobby with
 * a real HTTP 307 — instant, works without JS, no blank flash. The lobby
 * no longer links here either, so the screen is fully unreachable.
 *
 * To restore after the showcase:
 *   1. Delete this file.
 *   2. Re-add src/app/settings/page.tsx (previous body is in git history,
 *      commit before F-041):
 *
 *        'use client';
 *        import SettingsMenu from '@/components/SettingsMenu';
 *        import { useWipeNavigation } from '@/components/WipeTransition';
 *        export default function SettingsPage() {
 *          const { navigate } = useWipeNavigation();
 *          return <SettingsMenu onCancel={() => navigate('/lobby')} />;
 *        }
 *
 *   3. Re-add the SETTINGS item + 'S' shortcut in the lobby menu
 *      (src/app/lobby/page.tsx — instructions in its header comment).
 *
 * components/SettingsMenu.tsx was never touched — it is intact.
 */
export function GET(request: Request) {
  return NextResponse.redirect(new URL('/lobby', request.url), 307);
}
